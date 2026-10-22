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
// server and loop: 549 paused and 559 served backfill pages in the hour.
const PAUSED_PER_HOUR_BEFORE = 549;
const SERVED_PER_HOUR_BEFORE = 559;
const INBOX_FIRST_BEFORE_MS = 4800;

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
    console.info("PF-12a backfill simulation, one account, one hour", {
      pausedPerHour: server.paused.length,
      servedPerHour: server.served.length,
      pausedInsideKnownWindow: server.pausedInsideKnownWindow,
      inboxFirstMs,
    });
    expect(server.paused.length).toBeLessThanOrEqual(
      PAUSED_PER_HOUR_BEFORE * 0.3,
    );
    expect(inboxFirstMs).toBeLessThanOrEqual(INBOX_FIRST_BEFORE_MS);
    // The budget, not the engine, still sets how fast older mail arrives.
    expect(server.served.length).toBeGreaterThanOrEqual(
      SERVED_PER_HOUR_BEFORE * 0.95,
    );
    await engine.close();
  });

  it("waits at least the server's retry time and backs off further while the budget stays shut", async () => {
    const server = budgetedServer({
      backfillScopes: ["history"],
      shutBackfill: true,
    });
    const { engine } = await openEngine(server.source);

    await drive(engine, 30 * 60_000);

    const gaps = server.paused
      .slice(1)
      .map((pause, index) => pause.atMs - (server.paused[index]?.atMs ?? 0));
    expect(gaps.length).toBeGreaterThan(3);
    for (const [index, gap] of gaps.entries())
      expect(gap).toBeGreaterThanOrEqual(server.paused[index]!.retryAfterMs);
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

    expect(server.paused.map((pause) => pause.scopeId)).toEqual(["older-a"]);
    await engine.close();
  });

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
    while (!settled) await vi.advanceTimersByTimeAsync(50);
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
}: {
  backfillScopes: string[];
  shutBackfill?: boolean;
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
    primaryDoneAtMs: null as number | null,
    changesReads: 0,
  };
  const scopes: ScopeDescriptor[] = [
    { id: "primary", kind: "account", folderId: null },
    ...backfillScopes.map((id) => ({
      id,
      kind: "account" as const,
      folderId: null,
      priority: "low" as const,
    })),
  ];
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
      if (scopeId !== "primary") {
        const nowMs = Date.now();
        tokens = Math.min(
          BACKFILL_CAPACITY,
          tokens + ((nowMs - refilledAtMs) * BACKFILL_CAPACITY) / 60_000,
        );
        refilledAtMs = nowMs;
        if (shutBackfill || tokens < BACKFILL_PAGE_COST) {
          const retryAfterMs = shutBackfill
            ? 1000
            : Math.max(
                1000,
                Math.ceil(
                  ((BACKFILL_PAGE_COST - tokens) * 60_000) / BACKFILL_CAPACITY,
                ),
              );
          if (nowMs < knownPauseUntilMs) state.pausedInsideKnownWindow += 1;
          knownPauseUntilMs = nowMs + retryAfterMs;
          state.paused.push({ atMs: nowMs, retryAfterMs, scopeId });
          return { status: "paused", retryAfterMs, reason: "throttled" };
        }
        tokens -= BACKFILL_PAGE_COST;
      }
      await sleep(REQUEST_MS);
      pageNumber += 1;
      const changes = [messagePatch(`m-${scopeId}-${pageNumber}`)];
      if (scopeId === "primary" && pageIndex >= PRIMARY_PAGES) {
        state.primaryDoneAtMs = Date.now();
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
      if (scopeId !== "primary") state.served.push(Date.now());
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
