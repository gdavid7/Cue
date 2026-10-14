import { describe, expect, it } from "vitest";
import {
  createMailEngine,
  createHostRuntime,
  type MailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type {
  BodyObservation,
  ProviderChange,
} from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// Gmail's per-user quota and per-call costs; see
// apps/web/__tests__/playwright/mail-simulation/quota-proxy.mjs.
const GMAIL_UNITS_PER_MINUTE = 6000;
const COST = { list: 5, get: 20, history: 2 };
const SEARCH_PAGES = 40;
const SEARCH_PAGE_SIZE = 50;
const INVOICE: MailPredicate = {
  kind: "text",
  field: "any",
  value: "invoice",
  match: "term",
};

describe("engine Gmail quota use", () => {
  it("keeps an idle inbox with partial coverage under Gmail's per-minute quota", async () => {
    const { engine, store, meter } = await setup();
    // A search chain a previous session left in the local store. No view asks
    // for it now, so it must not keep walking the result set.
    await store.enqueueSearch({
      accountId: "acc-1",
      predicate: INVOICE,
      page: "page-7",
    });
    const inbox = engine.observeMailbox({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 50,
      after: null,
    });

    await runFor(engine, 1500);

    expect(meter.calls.search).toBe(0);
    expect(meter.units).toBeLessThan(GMAIL_UNITS_PER_MINUTE);
    expect(inbox.getSnapshot().data?.connection).toBe("ready");
    inbox.close();
    await engine.close();
  });

  it("fetches one search page for an open search view without fetching its messages twice", async () => {
    const { engine, meter } = await setup();
    const view = engine.observeMailboxWindow?.({
      accountIds: ["acc-1"],
      predicate: INVOICE,
      order: "newest_first",
      pageSize: SEARCH_PAGE_SIZE,
      after: null,
    });
    if (!view) throw new Error("engine has no mailbox windows");

    await runFor(engine, 1500);

    expect(meter.calls.search).toBe(1);
    expect(meter.calls.hydrate).toBe(0);
    expect(meter.units).toBeLessThan(GMAIL_UNITS_PER_MINUTE);
    await waitFor(
      () => (view.getSnapshot().data?.conversations.length ?? 0) > 0,
    );
    expect(view.getSnapshot().data?.conversations).toHaveLength(
      SEARCH_PAGE_SIZE,
    );

    await view.loadMore();
    await runFor(engine, 500);
    expect(meter.calls.search).toBe(2);
    view.close();
    await engine.close();
  });

  it("does not report a throttled account as waiting to sync", async () => {
    const { engine } = await setup({ throttleChanges: true });
    const inbox = engine.observeMailbox({
      accountIds: ["acc-1"],
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 50,
      after: null,
    });

    await runFor(engine, 500);

    await waitFor(() => inbox.getSnapshot().status === "ready");
    expect(inbox.getSnapshot().data?.connection).toBe("ready");
    inbox.close();
    await engine.close();
  });
});

async function setup(options: { throttleChanges?: boolean } = {}) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const meter = {
    units: 0,
    calls: { search: 0, hydrate: 0, enumerate: 0, changes: 0 },
  };
  const engine = createMailEngine({
    store,
    source: gmailCostSource(meter, options),
    executor: {
      async execute() {
        return { status: "uncertain", receiptId: null };
      },
      async inspect() {
        return { status: "uncertain", receiptId: null };
      },
    },
    runtime: createHostRuntime(),
    idleCatchUpIntervalMs: 60_000,
  });
  return { engine, store, meter };
}

async function runFor(engine: MailEngine, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await engine.runUntil(Math.min(deadline, Date.now() + 100));
  }
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// A Gmail-shaped source: the recent "primary" window is already enumerated,
// the "history" backfill is paced by the sync budget, and every provider call
// is charged at Gmail's unit cost.
function gmailCostSource(
  meter: {
    units: number;
    calls: Record<"search" | "hydrate" | "enumerate" | "changes", number>;
  },
  options: { throttleChanges?: boolean },
): MailboxSource {
  return {
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
      return {
        status: "ok",
        value: {
          scopes: [
            { id: "primary", kind: "account", folderId: null },
            { id: "history", kind: "account", folderId: null, priority: "low" },
          ],
          nextPage: null,
        },
      };
    },
    async beginBootstrap({ scope, session }) {
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          enumerationToken: scope.id,
          catchUpFrom: {
            streamId: scope.id,
            generation: session.generation,
            checkpoint: "h1",
          },
        },
      };
    },
    async enumerate({ page, session }) {
      meter.calls.enumerate += 1;
      if (page === "history") {
        // The backfill waits on the sync budget before spending anything.
        return { status: "paused", retryAfterMs: 30_000, reason: "throttled" };
      }
      const messages = range(0, 20).map((index) => `recent-${index}`);
      meter.units += COST.list + messages.length * COST.get;
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          scopeId: "primary",
          changes: messages.map((id) => messagePatch(id, ["inbox"])),
          requiredHydration: [],
          bodies: messages.map(body),
          nextPage: null,
          catchUpFrom: {
            streamId: "primary",
            generation: session.generation,
            checkpoint: "h1",
          },
        },
      };
    },
    async readChanges({ position, session, requestId }) {
      meter.calls.changes += 1;
      meter.units += COST.history;
      if (options.throttleChanges) {
        return { status: "paused", retryAfterMs: 30_000, reason: "throttled" };
      }
      return {
        status: "page",
        page: {
          session,
          requestId,
          from: position,
          to: position,
          changes: [],
          requiredHydration: [],
          roundComplete: true,
        },
      };
    },
    async hydrate({ keys }) {
      meter.calls.hydrate += 1;
      meter.units += keys.length * COST.get;
      return {
        status: "ok",
        value: {
          changes: keys.map((key) => messagePatch(key.messageId, ["all"])),
          bodies: keys.map((key) => body(key.messageId)),
          unresolved: [],
        },
      };
    },
    async readConversationMembership() {
      return { status: "paused", retryAfterMs: 1000, reason: "unavailable" };
    },
    async search({ page, pageSize }) {
      meter.calls.search += 1;
      const index = page ? Number(page.replace("page-", "")) : 0;
      const ids = range(0, pageSize).map(
        (offset) => `found-${index * pageSize + offset}`,
      );
      // messages.list plus one FULL messages.get per candidate.
      meter.units += COST.list + ids.length * COST.get;
      return {
        status: "ok",
        value: {
          matches: ids.map((messageId) => ({ accountId: "acc-1", messageId })),
          changes: ids.map((id) => messagePatch(id, ["all"])),
          bodies: ids.map(body),
          nextPage: index + 1 < SEARCH_PAGES ? `page-${index + 1}` : null,
          semantics: "candidates_require_local_filter",
        },
      };
    },
    async readAttachment() {
      return { status: "paused", retryAfterMs: 1000, reason: "unavailable" };
    },
  };
}

function messagePatch(
  messageId: string,
  roles: Array<"inbox" | "all">,
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId },
    reference: {
      provider: "google",
      messageId,
      conversationId: `c-${messageId}`,
      version: "1",
    },
    fields: {
      subject: `Invoice ${messageId}`,
      preview: "invoice",
      from: "billing@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: true,
      starred: false,
      folderId: null,
      labelIds: roles.includes("inbox") ? ["INBOX"] : [],
      categoryIds: [],
      roles: roles.filter((role) => role === "inbox"),
      hasAttachments: false,
    },
  } as ProviderChange;
}

function body(messageId: string): BodyObservation {
  return {
    key: { accountId: "acc-1", messageId },
    version: "1",
    html: null,
    text: "invoice",
  };
}

function range(start: number, end: number) {
  return Array.from({ length: end - start }, (_, index) => start + index);
}
