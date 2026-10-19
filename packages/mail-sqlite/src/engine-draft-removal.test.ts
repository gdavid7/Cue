import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type {
  ExecutionResult,
  OperationExecutor,
} from "@inboxzero/mail-core/ports/operation-executor";
import type { MailboxRole } from "@inboxzero/mail-core/messages";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("drafts the provider removed", () => {
  it("keeps a discarded draft gone after the engine restarts, in that account only", async () => {
    const path = await databasePath();
    const first = await openEngine(path);
    await seed(first.store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
      patch("acc-1", "thread-2", "inbox-1", ["inbox"]),
    ]);
    await seed(first.store, "acc-2", [
      patch("acc-2", "thread-3", "draft-1", ["draft"]),
    ]);

    await first.engine.forgetDeletedDrafts?.({
      accountId: "acc-1",
      // A message that isn't a draft is never removed this way.
      messageIds: ["draft-1", "inbox-1"],
    });
    await first.engine.close();

    const second = await openEngine(path);
    expect(await draftConversations(second.store)).toEqual([
      { accountId: "acc-2", conversationId: "thread-3" },
    ]);
    const inbox = await second.store.readMailboxView(
      mailboxQuery(["acc-1"], "inbox"),
    );
    expect(
      inbox.view.conversations.map((row) => row.key.conversationId),
    ).toEqual(["thread-2"]);
    await second.engine.close();
  });

  it("updates an open Drafts view at once", async () => {
    const { engine, store } = await openEngine(await databasePath());
    await seed(store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    const handle = engine.observeMailbox(mailboxQuery(["acc-1"], "draft"));
    await vi.waitFor(() =>
      expect(handle.getSnapshot().data?.conversations).toHaveLength(1),
    );

    await engine.forgetDeletedDrafts?.({
      accountId: "acc-1",
      messageIds: ["draft-1"],
    });

    expect(handle.getSnapshot().data?.conversations).toEqual([]);
    handle.close();
    await engine.close();
  });

  it("shows the draft again if the provider later reports it", async () => {
    const { engine, store } = await openEngine(await databasePath());
    await seed(store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    await engine.forgetDeletedDrafts?.({
      accountId: "acc-1",
      messageIds: ["draft-1"],
    });
    expect(await draftConversations(store)).toEqual([]);

    await syncPage(store, "acc-1", "2", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);

    expect(await draftConversations(store)).toEqual([
      { accountId: "acc-1", conversationId: "thread-1" },
    ]);
    await engine.close();
  });

  it("drops a sent draft's mailbox copy once the send is confirmed, across a restart", async () => {
    const path = await databasePath();
    const sent = patch("acc-1", "thread-1", "sent-1", ["sent"]);
    const first = await openEngine(path, {
      status: "confirmed",
      receiptId: "receipt-1",
      observations: [sent],
      targets: [],
    });
    await seed(first.store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    await queueSend(first.engine);

    await first.engine.runUntil(Date.now() + 300);
    await first.engine.close();

    const second = await openEngine(path);
    expect(await draftConversations(second.store)).toEqual([]);
    const sentView = await second.store.readMailboxView(
      mailboxQuery(["acc-1"], "sent"),
    );
    expect(sentView.view.conversations).toHaveLength(1);
    await second.engine.close();
  });

  it("keeps the sent message when the provider sent the draft under its own id", async () => {
    const path = await databasePath();
    const first = await openEngine(path, {
      status: "confirmed",
      receiptId: "receipt-1",
      observations: [patch("acc-1", "thread-1", "draft-1", ["sent"])],
      targets: [],
    });
    await seed(first.store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    await queueSend(first.engine);

    await first.engine.runUntil(Date.now() + 300);
    await first.engine.close();

    const second = await openEngine(path);
    expect(await draftConversations(second.store)).toEqual([]);
    expect(await liveMessageIds(second.store)).toEqual(["draft-1"]);
    await second.engine.close();
  });

  // Gmail keeps the draft's id for the sent message, so a row still marked a
  // draft here may be the message just sent; it waits for sync instead.
  it("keeps the draft's row when the confirmed send names no sent message", async () => {
    const path = await databasePath();
    const first = await openEngine(path, {
      status: "confirmed",
      receiptId: "receipt-1",
      observations: [],
      targets: [],
    });
    await seed(first.store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    await queueSend(first.engine);

    await first.engine.runUntil(Date.now() + 300);
    await first.engine.close();

    const second = await openEngine(path);
    expect(await liveMessageIds(second.store)).toEqual(["draft-1"]);
    await second.engine.close();
  });

  it("leaves a message that isn't a draft when asked to forget it", async () => {
    const { engine, store } = await openEngine(await databasePath());
    await seed(store, "acc-1", [
      patch("acc-1", "thread-1", "sent-1", ["sent"]),
    ]);

    await engine.forgetDeletedDrafts?.({
      accountId: "acc-1",
      messageIds: ["sent-1"],
    });

    expect(await liveMessageIds(store)).toEqual(["sent-1"]);
    await engine.close();
  });

  it("keeps the draft when the provider rejects the send", async () => {
    const path = await databasePath();
    const first = await openEngine(path, {
      status: "rejected",
      code: "provider_rejected",
      targets: [],
    });
    await seed(first.store, "acc-1", [
      patch("acc-1", "thread-1", "draft-1", ["draft"]),
    ]);
    await queueSend(first.engine);

    await first.engine.runUntil(Date.now() + 300);
    await first.engine.close();

    const second = await openEngine(path);
    expect(await draftConversations(second.store)).toEqual([
      { accountId: "acc-1", conversationId: "thread-1" },
    ]);
    const conversation = await second.store.readConversation(
      { accountId: "acc-1", conversationId: "thread-1" },
      { after: null, pageSize: 10 },
    );
    expect(
      conversation.view.messages.map((message) => message.key.messageId),
    ).toEqual(["draft-1"]);
    await second.engine.close();
  });
});

async function liveMessageIds(
  store: Awaited<ReturnType<typeof createSqliteMailStore>>,
) {
  const { messages } = await store.inspect({ accountIds: ["acc-1"] });
  return messages
    .filter((message) => !message.deleted)
    .map((message) => message.messageId);
}

async function databasePath() {
  const directory = await mkdtemp(join(tmpdir(), "mail-draft-removal-"));
  directories.push(directory);
  return join(directory, "mailbox.sqlite");
}

async function openEngine(path: string, result?: ExecutionResult) {
  const store = await createSqliteMailStore(createNodeSqliteDriver(path));
  const executor: OperationExecutor = {
    execute: vi.fn(async () => {
      if (!result) throw new Error("no command expected");
      return result;
    }),
    inspect: vi.fn(async () => ({
      status: "uncertain" as const,
      receiptId: null,
    })),
  };
  const engine = createMailEngine({
    store,
    source: idleSource(),
    executor,
    runtime: createHostRuntime(),
  });
  return { store, engine };
}

async function queueSend(engine: ReturnType<typeof createMailEngine>) {
  const draft = { accountId: "acc-1", draftId: "local-draft-1" };
  const saved = await engine.saveDraft({
    key: draft,
    expectedRevision: null,
    content: {
      to: ["ada@example.com"],
      cc: [],
      bcc: [],
      subject: "Plans",
      editableHtml: "<p>Thursday works.</p>",
      quotedHtml: "",
      providerDraftId: "r-1",
      providerDraftMessageIds: ["draft-1"],
    },
  });
  if (saved.status !== "saved") throw new Error("expected save");
  const admission = await engine.submitSend({
    commandId: "send-1",
    draft,
    draftRevision: saved.draftRevision,
    conversationId: "thread-1",
    replyTo: null,
  });
  expect(admission.status).toBe("queued");
}

async function seed(
  store: Awaited<ReturnType<typeof createSqliteMailStore>>,
  accountId: string,
  changes: ProviderChange[],
) {
  await store.ensureAccount({
    accountId,
    provider: "google",
    generation: "g1",
  });
  await syncPage(store, accountId, "1", changes, null);
}

async function syncPage(
  store: Awaited<ReturnType<typeof createSqliteMailStore>>,
  accountId: string,
  checkpoint: string,
  changes: ProviderChange[],
  previous: string | null = String(Number(checkpoint) - 1),
) {
  const result = await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId, generation: "g1" },
      requestId: `sync-${accountId}-${checkpoint}`,
      from: { streamId: "primary", generation: "g1", checkpoint: previous },
      to: { streamId: "primary", generation: "g1", checkpoint },
      changes,
      requiredHydration: [],
      roundComplete: true,
    },
  });
  expect(result.status).toBe("committed");
}

async function draftConversations(
  store: Awaited<ReturnType<typeof createSqliteMailStore>>,
) {
  const { view } = await store.readMailboxView(
    mailboxQuery(["acc-1", "acc-2"], "draft"),
  );
  return view.conversations
    .map((row) => row.key)
    .sort((a, b) => a.accountId.localeCompare(b.accountId));
}

function mailboxQuery(accountIds: string[], role: "inbox" | "sent" | "draft") {
  return {
    accountIds,
    predicate: { kind: "role" as const, role },
    order: "newest_first" as const,
    pageSize: 25,
    after: null,
  };
}

function patch(
  accountId: string,
  conversationId: string,
  messageId: string,
  roles: MailboxRole[],
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId, messageId },
    reference: { provider: "google", messageId, conversationId, version: "1" },
    fields: {
      subject: conversationId,
      preview: messageId,
      from: "me@example.com",
      to: ["ada@example.com"],
      cc: [],
      receivedAtMs: 1,
      read: true,
      starred: false,
      folderId: null,
      labelIds: roles.map((role) => role.toUpperCase()),
      categoryIds: [],
      roles,
      hasAttachments: false,
    },
  };
}

function idleSource(): MailboxSource {
  const paused = {
    status: "paused" as const,
    retryAfterMs: 0,
    reason: "unavailable" as const,
  };
  return {
    async describe() {
      return {
        status: "ok",
        value: {
          strategy: "account_history",
          supportedChanges: ["archive"],
          maxPageSize: 10,
          maxHydrationBatch: 10,
        },
      };
    },
    async discoverScopes() {
      return paused;
    },
    async beginBootstrap() {
      return paused;
    },
    async enumerate() {
      return paused;
    },
    async readChanges() {
      return paused;
    },
    async hydrate() {
      return paused;
    },
    async readConversationMembership() {
      return paused;
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return paused;
    },
  };
}
