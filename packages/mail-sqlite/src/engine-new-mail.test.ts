import { describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
  type MailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// A Gmail account's older mail backfills page by page in a low-priority scope,
// and under the shared Gmail quota one backfill page can take tens of seconds.
// New mail arrives through the primary stream's catch-up, which must not wait
// behind that page.
describe("engine new mail", () => {
  it("shows mail that arrives while a backfill page is in flight", async () => {
    const gmail = gmailWithBackfill();
    const { engine, inbox } = await openMailbox(gmail.source);
    await engine.runUntil(Date.now() + 300);
    await vi.waitFor(() => expect(gmail.backfillPagesStarted()).toBe(1));

    gmail.deliver("m-new");
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(Date.now() + 300);

    expect(inboxMessageIds(inbox)).toContain("m-new");
    gmail.releaseBackfill();
    inbox.close();
    await engine.close();
  });
});

async function openMailbox(source: MailboxSource) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  const engine: MailEngine = createMailEngine({
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
    runtime: createHostRuntime(),
  });
  const inbox = engine.observeMailbox({
    accountIds: ["acc-1"],
    predicate: { kind: "role", role: "inbox" },
    order: "newest_first",
    pageSize: 50,
    after: null,
  });
  return { engine, inbox };
}

function inboxMessageIds(inbox: ReturnType<MailEngine["observeMailbox"]>) {
  return (inbox.getSnapshot().data?.conversations ?? []).map((conversation) =>
    conversation.key.conversationId.replace(/^c-/, "m-"),
  );
}

// The primary scan of recent mail finishes on its first page; the backfill
// never does, and every page after the first is held until released.
function gmailWithBackfill() {
  const arrived: string[] = [];
  let backfillPages = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let checkpoint = 0;
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
          enumerationToken: `${scope.id}-1`,
          catchUpFrom: {
            streamId: scope.id,
            generation: session.generation,
            checkpoint: `${scope.id}-start`,
          },
        },
      };
    },
    async enumerate({ page, session }) {
      if (page.startsWith("primary")) {
        return {
          status: "ok",
          value: {
            bootstrapId: "mailbox",
            scopeId: "primary",
            changes: [messagePatch("m-old")],
            requiredHydration: [],
            bodies: [],
            nextPage: null,
            catchUpFrom: {
              streamId: "primary",
              generation: session.generation,
              checkpoint: "primary-0",
            },
          },
        };
      }
      backfillPages += 1;
      await held;
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          scopeId: "history",
          changes: [messagePatch(`m-older-${backfillPages}`)],
          requiredHydration: [],
          bodies: [],
          nextPage: `history-${backfillPages + 1}`,
          catchUpFrom: null,
        },
      };
    },
    async readChanges({ position, session, requestId }) {
      checkpoint += 1;
      const changes = arrived.splice(0).map(messagePatch);
      return {
        status: "page",
        page: {
          session,
          requestId,
          from: position,
          to: { ...position, checkpoint: `primary-${checkpoint}` },
          changes,
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
  return {
    source,
    deliver: (messageId: string) => arrived.push(messageId),
    backfillPagesStarted: () => backfillPages,
    releaseBackfill: () => release(),
  };
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
