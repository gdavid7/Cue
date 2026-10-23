import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailEngine,
} from "@inboxzero/mail-core/engine";
import type {
  MailboxSource,
  ScopeDescriptor,
} from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// The server's backfill envelope for one Gmail account: a token bucket that
// refills its capacity once a minute and answers a page it can't afford with
// the exact time until it can (see apps/web/utils/email/local-mail-sync-budget.ts).
const BACKFILL_CAPACITY = 5000;
const BACKFILL_PAGE_COST = 545;
const PRIMARY_PAGES = 3;
const REQUEST_MS = 1500;
const CHANGES_MS = 300;
// Focus, visibility and pushed-change hints all reach the engine as this.
const WAKE_EVERY_MS = 20_000;
const HOUR_MS = 60 * 60_000;
// Measured on the engine before backfill pauses backed off, with this file's
// server and loop: 549 paused and 559 served backfill pages in the hour,
// and the inbox-first scan done in 4.75 seconds.
const PAUSED_PER_HOUR_BEFORE = 549;
const SERVED_PER_HOUR_BEFORE = 559;
const INBOX_FIRST_BEFORE_MS = 4750;

describe("engine backfill pauses", () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: 1_000_000 });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks a paused backfill budget far less often during a long backfill without slowing the inbox", async () => {
    const server = budgetedServer({ backfillScopes: ["history"] });
    const { engine, startedAtMs } = await openEngine(server.source);

    await drive(engine, HOUR_MS, { wakeEveryMs: WAKE_EVERY_MS });

    const inboxFirstMs =
      (server.primaryDoneAtMs ?? Number.POSITIVE_INFINITY) - startedAtMs;
    expect(server.paused.length).toBeLessThanOrEqual(
      PAUSED_PER_HOUR_BEFORE * 0.3,
    );
    expect(inboxFirstMs).toBeLessThanOrEqual(INBOX_FIRST_BEFORE_MS);
    // The budget, not the engine, still sets how fast older mail arrives.
    expect(server.served.length).toBeGreaterThanOrEqual(
      SERVED_PER_HOUR_BEFORE * 0.95,
    );
    // A client that waits out every pause it is given never asks inside one,
    // so the server has nothing to refuse early.
    expect(server.pausedInsideKnownWindow).toBe(0);
    await engine.close();
  }, 60_000);

  it("waits at least the server's retry time and backs off further while the budget stays shut", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      shutBackfill: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 30 * 60_000);

    // Pauses met while the primary scan ran end with it (see below), so the
    // back-off is measured from the first ask after it.
    const paused = server.paused.filter(
      (pause) => pause.atMs >= (server.primaryDoneAtMs ?? 0),
    );
    const gaps = paused
      .slice(1)
      .map((pause, index) => pause.atMs - (paused[index]?.atMs ?? 0));
    expect(gaps.length).toBeGreaterThan(3);
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(30_000);
    expect(gaps[1]).toBeGreaterThan(gaps[0]!);
    expect(gaps[2]).toBeGreaterThan(gaps[1]!);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(5 * 60_000 + 5000);
    await engine.close();
  });

  it("holds every background scope of the account after one is paused", async () => {
    const server = budgetedServer({
      backfillScopes: ["older-a", "older-b"],
      shutBackfill: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 20_000);

    // Asked again once, when the primary scan it may have waited for ends.
    expect(server.paused.map((pause) => pause.scopeId)).toEqual([
      "older-a",
      "older-a",
    ]);
    await engine.close();
  });

  it("holds the account's other background scopes when a backfill's start is paused", async () => {
    const server = budgetedServer({
      backfillScopes: ["older-a", "older-b"],
      shutBackfill: true,
      pauseBootstrap: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 20_000);

    // Once more when the primary scan ends, then held.
    expect(server.backfillBootstraps).toBe(2);
    await engine.close();
  });

  it("starts backing off afresh once the budget serves a page", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      shutBackfill: true,
    });
    const { engine } = await openEngine(server.source);
    await drive(engine, 3 * 60_000);
    expect(server.paused.length).toBeGreaterThanOrEqual(3);
    server.shut = false;
    while (server.served.length === 0) await drive(engine, 5000);
    server.shut = true;
    const pausedBefore = server.paused.length;

    await drive(engine, 60_000);

    const [first, second] = server.paused.slice(pausedBefore);
    expect(second!.atMs - first!.atMs).toBeLessThan(40_000);
    await engine.close();
  });

  it("retries an unavailable backfill when the server says", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      shutBackfill: true,
      pauseReason: "unavailable",
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 30_000);

    expect(server.paused.length).toBeGreaterThan(5);
    await engine.close();
  });

  // The server holds background scans while a first sync's primary scan runs,
  // so a pause met then says nothing about the budget: it ends with the scan.
  it("starts a backfill held behind the primary scan as soon as that scan ends", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      holdBackfillDuringPrimary: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 30_000);

    expect(server.paused.length).toBeGreaterThan(0);
    expect(server.primaryDoneAtMs).not.toBeNull();
    const firstServedAtMs = server.served[0] ?? Number.POSITIVE_INFINITY;
    expect(firstServedAtMs - server.primaryDoneAtMs!).toBeLessThan(5000);
    await engine.close();
  });

  it("keeps holding the backfill while another scan it waits behind still runs", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      foregroundScopes: ["folder-b"],
      holdBackfillDuringPrimary: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 60_000);

    const primaryDoneAtMs = server.foregroundDoneAtMs.get("primary")!;
    const folderDoneAtMs = server.foregroundDoneAtMs.get("folder-b")!;
    expect(folderDoneAtMs).toBeGreaterThan(primaryDoneAtMs);
    // Nothing asked between the primary scan ending and the last one ending.
    const askedBetween = [
      ...server.paused.map((pause) => pause.atMs),
      ...server.served,
    ].filter((atMs) => atMs > primaryDoneAtMs && atMs < folderDoneAtMs);
    expect(askedBetween).toEqual([]);
    const firstServedAtMs = server.served[0] ?? Number.POSITIVE_INFINITY;
    expect(firstServedAtMs - folderDoneAtMs).toBeLessThan(5000);
    await engine.close();
  });

  it("adds no backfill asks for sync requests once the primary scan has ended", async () => {
    const run = async (wakeEveryMs?: number) => {
      const server = budgetedServer({
        backfillScopes: ["history"],
        shutBackfill: true,
      });
      const { engine } = await openEngine(server.source);
      await drive(engine, 10 * 60_000, { wakeEveryMs });
      await engine.close();
      return server.paused.filter(
        (pause) => pause.atMs > (server.primaryDoneAtMs ?? 0),
      ).length;
    };

    const scheduled = await run();
    const woken = await run(2000);

    expect(scheduled).toBeGreaterThan(2);
    expect(woken).toBeLessThanOrEqual(scheduled);
  }, 60_000);

  it("keeps reading new mail while the backfill is paused", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      shutBackfill: true,
    });
    const { engine } = await openEngine(server.source);
    await drive(engine, 10_000);
    const before = server.changesReads;

    await drive(engine, 10_000, { wakeEveryMs: 2000 });

    expect(server.changesReads).toBeGreaterThan(before);
    await engine.close();
  });
});

async function openEngine(source: MailboxSource) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const engine = createMailEngine({
    store,
    source,
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime({ random: () => 0.5 }),
  });
  return { engine, startedAtMs: Date.now() };
}

// The host's loop (apps/web/utils/mail-engine/engine-loop.ts): two-second
// turns a quarter second apart, with the browser's wakeups on top.
async function drive(
  engine: MailEngine,
  durationMs: number,
  { wakeEveryMs }: { wakeEveryMs?: number } = {},
) {
  const endMs = Date.now() + durationMs;
  let nextWakeMs = wakeEveryMs
    ? Date.now() + wakeEveryMs
    : Number.POSITIVE_INFINITY;
  while (Date.now() < endMs) {
    let settled = false;
    const turn = engine
      .runUntil(Date.now() + 2000)
      .catch(() => undefined)
      .finally(() => {
        settled = true;
      });
    while (!settled) await vi.advanceTimersToNextTimerAsync();
    await turn;
    await vi.advanceTimersByTimeAsync(250);
    if (Date.now() >= nextWakeMs) {
      nextWakeMs += wakeEveryMs ?? Number.POSITIVE_INFINITY;
      await engine.requestSync(["acc-1"]);
    }
  }
}

function budgetedServer({
  backfillScopes,
  shutBackfill = false,
  pauseBootstrap = false,
  pauseReason = "throttled",
  holdBackfillDuringPrimary = false,
  foregroundScopes = [],
}: {
  backfillScopes: string[];
  shutBackfill?: boolean;
  holdBackfillDuringPrimary?: boolean;
  /** Further scopes the server holds background scans behind, as primary. */
  foregroundScopes?: string[];
  pauseBootstrap?: boolean;
  pauseReason?: "throttled" | "unavailable";
}) {
  let tokens = BACKFILL_CAPACITY;
  let refilledAtMs = Date.now();
  let knownPauseUntilMs = 0;
  let pageNumber = 0;
  const state = {
    paused: [] as Array<{
      atMs: number;
      retryAfterMs: number;
      scopeId: string;
    }>,
    served: [] as number[],
    pausedInsideKnownWindow: 0,
    shut: shutBackfill,
    backfillBootstraps: 0,
    primaryDoneAtMs: null as number | null,
    foregroundDoneAtMs: new Map<string, number>(),
    changesReads: 0,
  };
  const scopes: ScopeDescriptor[] = [
    { id: "primary", kind: "account", folderId: null },
    ...foregroundScopes.map((id) => ({
      id,
      kind: "account" as const,
      folderId: null,
    })),
    ...backfillScopes.map((id) => ({
      id,
      kind: "account" as const,
      folderId: null,
      priority: "low" as const,
    })),
  ];
  const isForeground = (scopeId: string) =>
    scopeId === "primary" || foregroundScopes.includes(scopeId);
  const source: MailboxSource = {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: ["archive"],
          maxPageSize: 50,
          maxHydrationBatch: 20,
        },
      };
    },
    async discoverScopes() {
      return { status: "ok", value: { scopes, nextPage: null } };
    },
    async beginBootstrap({ scope, session }) {
      if (!isForeground(scope.id)) {
        state.backfillBootstraps += 1;
        if (pauseBootstrap)
          return { status: "paused", retryAfterMs: 1000, reason: pauseReason };
      }
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          enumerationToken: `${scope.id}:1`,
          catchUpFrom: {
            streamId: scope.id,
            generation: session.generation,
            checkpoint: `${scope.id}-start`,
          },
        },
      };
    },
    async enumerate({ page, session }) {
      const [scopeId = "", index = "1"] = page.split(":");
      const pageIndex = Number(index);
      if (!isForeground(scopeId)) {
        const nowMs = Date.now();
        tokens = Math.min(
          BACKFILL_CAPACITY,
          tokens + ((nowMs - refilledAtMs) * BACKFILL_CAPACITY) / 60_000,
        );
        refilledAtMs = nowMs;
        const held =
          holdBackfillDuringPrimary &&
          state.foregroundDoneAtMs.size < foregroundScopes.length + 1;
        if (state.shut || held || tokens < BACKFILL_PAGE_COST) {
          const retryAfterMs =
            state.shut || held
              ? 1000
              : Math.max(
                  1000,
                  Math.ceil(
                    ((BACKFILL_PAGE_COST - tokens) * 60_000) /
                      BACKFILL_CAPACITY,
                  ),
                );
          if (nowMs < knownPauseUntilMs) state.pausedInsideKnownWindow += 1;
          knownPauseUntilMs = nowMs + retryAfterMs;
          state.paused.push({ atMs: nowMs, retryAfterMs, scopeId });
          return { status: "paused", retryAfterMs, reason: pauseReason };
        }
        tokens -= BACKFILL_PAGE_COST;
      }
      await sleep(REQUEST_MS);
      pageNumber += 1;
      const changes = [messagePatch(`m-${scopeId}-${pageNumber}`)];
      // Further scopes are longer, so they run on after the primary scan.
      const lastPage =
        scopeId === "primary" ? PRIMARY_PAGES : PRIMARY_PAGES * 4;
      if (isForeground(scopeId) && pageIndex >= lastPage) {
        state.foregroundDoneAtMs.set(scopeId, Date.now());
        if (scopeId === "primary") state.primaryDoneAtMs = Date.now();
        return {
          status: "ok",
          value: {
            bootstrapId: "mailbox",
            scopeId,
            changes,
            requiredHydration: [],
            bodies: [],
            nextPage: null,
            catchUpFrom: {
              streamId: scopeId,
              generation: session.generation,
              checkpoint: `${scopeId}-done`,
            },
          },
        };
      }
      if (!isForeground(scopeId)) state.served.push(Date.now());
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          scopeId,
          changes,
          requiredHydration: [],
          bodies: [],
          nextPage: `${scopeId}:${pageIndex + 1}`,
          catchUpFrom: null,
        },
      };
    },
    async readChanges({ position, session, requestId }) {
      state.changesReads += 1;
      await sleep(CHANGES_MS);
      return {
        status: "page",
        page: {
          session,
          requestId,
          from: position,
          to: { ...position, checkpoint: `${position.streamId}-${Date.now()}` },
          changes: [],
          requiredHydration: [],
          roundComplete: true,
        },
      };
    },
    async hydrate() {
      return {
        status: "ok",
        value: { changes: [], bodies: [], unresolved: [] },
      };
    },
    async readConversationMembership() {
      return { status: "paused", retryAfterMs: 1000, reason: "unavailable" };
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return { status: "paused", retryAfterMs: 1000, reason: "unavailable" };
    },
  };
  return Object.assign(state, { source });
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function messagePatch(
  messageId: string,
): Extract<ProviderChange, { kind: "message_patch" }> {
  const conversationId = messageId.replace(/^m-/, "c-");
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider: "google",
      messageId,
      conversationId,
      version: "1",
    },
    fields: {
      subject: messageId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: false,
      starred: false,
      folderId: "inbox",
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
