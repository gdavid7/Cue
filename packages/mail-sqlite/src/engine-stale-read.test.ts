import { describe, expect, it } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

// Outlook's change keys can't be ordered, so the engine dates each read by
// when it sent it.
describe("engine reads in flight during a local change", () => {
  it("keeps a star confirmed while a sync read was out", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({
      accountId: "acc-1",
      provider: "microsoft",
      generation: "g1",
    });
    const outlook = outlookSource(store);
    const engine = createMailEngine({
      store,
      source: outlook.source,
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
    await engine.runUntil(Date.now() + 300);
    expect(await starred(store)).toBe(false);

    outlook.starWhileNextReadIsOut();
    await engine.requestSync(["acc-1"]);
    await engine.runUntil(Date.now() + 300);

    expect(outlook.readsSent()).toBeGreaterThan(0);
    expect(await starred(store)).toBe(true);
    await engine.close();
  });
});

// The next change read finds the message unstarred and, while it is out,
// another tab's engine confirms a star on the same database.
function outlookSource(store: MailStore) {
  let starPending = false;
  let reads = 0;
  let checkpoint = 0;
  const source: MailboxSource = {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "folder_delta",
          supportedChanges: ["set_starred"],
          maxPageSize: 50,
          maxHydrationBatch: 20,
        },
      };
    },
    async discoverScopes() {
      return {
        status: "ok",
        value: {
          scopes: [{ id: "primary", kind: "account", folderId: null }],
          nextPage: null,
        },
      };
    },
    async beginBootstrap({ session }) {
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          enumerationToken: "primary-1",
          catchUpFrom: {
            streamId: "primary",
            generation: session.generation,
            checkpoint: "primary-start",
          },
        },
      };
    },
    async enumerate({ session }) {
      return {
        status: "ok",
        value: {
          bootstrapId: "mailbox",
          scopeId: "primary",
          changes: [patch(false)],
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
    },
    async readChanges({ position, session, requestId }) {
      checkpoint += 1;
      const changes: ProviderChange[] = [];
      if (starPending) {
        starPending = false;
        reads += 1;
        await confirmStarElsewhere(store);
        changes.push(patch(false));
      }
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
    starWhileNextReadIsOut: () => {
      starPending = true;
    },
    readsSent: () => reads,
  };
}

async function confirmStarElsewhere(store: MailStore) {
  await store.admitMetadata({
    accountId: "acc-1",
    commandId: "star-elsewhere",
    targets: [{ accountId: "acc-1", messageId: "m1" }],
    change: { kind: "set_starred", starred: true },
  });
  const work = await store.claimWork({
    ownerId: "other-tab",
    nowMs: Date.now(),
    leaseMs: 30_000,
  });
  if (work?.kind !== "command") throw new Error("expected the star");
  await store.settleAttempt({
    attemptId: work.attemptId,
    operation: work.operation,
    result: {
      status: "confirmed",
      receiptId: null,
      observations: [patch(true)],
      targets: [
        {
          key: { accountId: "acc-1", messageId: "m1" },
          outcome: "applied",
          code: null,
        },
      ],
    },
  });
}

async function starred(store: MailStore) {
  const inspection = await store.inspect();
  return inspection.messages.find((message) => message.messageId === "m1")
    ?.effective.starred;
}

function patch(
  isStarred: boolean,
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId: "m1" },
    reference: {
      provider: "microsoft",
      messageId: "m1",
      conversationId: "c1",
      version: null,
    },
    fields: {
      subject: "subject",
      preview: "preview",
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000,
      read: false,
      starred: isStarred,
      folderId: "inbox",
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
