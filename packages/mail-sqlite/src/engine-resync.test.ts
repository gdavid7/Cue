import { describe, expect, it } from "vitest";
import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import type { MailboxSource } from "@inboxzero/mail-core/ports/mailbox-source";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const session = { accountId: "acc-1", generation: "g1" };
const inboxQuery = {
  accountIds: ["acc-1"],
  predicate: { kind: "role" as const, role: "inbox" as const },
  order: "newest_first" as const,
  pageSize: 25,
  after: null,
};

describe("first sync or resync", () => {
  it("tells the source a mailbox with nothing synced yet is starting its first sync", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "google" });
    const begun: Array<boolean | undefined> = [];
    const engine = createMailEngine({
      store,
      source: expiredHistorySource({
        enumerated: [gmailPatch("first", 5000)],
        resets: false,
        onBegin: (initial) => begun.push(initial),
      }),
      executor: noExecutor,
      runtime: createHostRuntime({ nowMs: () => 10_000 }),
    });

    await engine.requestSync(["acc-1"]);
    await engine.runUntil(Date.now() + 2000);

    expect(begun).toEqual([true]);
    await engine.close();
  });

  it("tells the source a resync after expired history is not a first sync", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "google" });
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session,
        requestId: "synced",
        from: { streamId: "primary", generation: "g1", checkpoint: null },
        to: { streamId: "primary", generation: "g1", checkpoint: "h1" },
        changes: [gmailPatch("kept", 5000)],
        requiredHydration: [],
        roundComplete: true,
      },
    });
    const begun: Array<boolean | undefined> = [];
    const engine = createMailEngine({
      store,
      source: expiredHistorySource({
        enumerated: [gmailPatch("kept", 5000)],
        onBegin: (initial) => begun.push(initial),
      }),
      executor: noExecutor,
      runtime: createHostRuntime({ nowMs: () => 10_000 }),
    });

    await engine.requestSync(["acc-1"]);
    for (let pass = 0; pass < 2; pass++)
      await engine.runUntil(Date.now() + 2000);

    expect(begun).toEqual([false]);
    await engine.close();
  });
});

const noExecutor = {
  async execute() {
    return { status: "uncertain" as const, receiptId: null };
  },
  async inspect() {
    return { status: "uncertain" as const, receiptId: null };
  },
};

describe("engine resync after a long time offline", () => {
  it("drops mail deleted elsewhere while Gmail history expired, and keeps local drafts", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "google" });
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session,
        requestId: "before-offline",
        from: { streamId: "primary", generation: "g1", checkpoint: null },
        to: { streamId: "primary", generation: "g1", checkpoint: "h1" },
        changes: [
          gmailPatch("kept", 5000),
          gmailPatch("deleted-elsewhere", 6000),
          gmailPatch("older-than-scan", 1000),
        ],
        requiredHydration: [],
        roundComplete: true,
      },
    });
    const draft = await store.saveDraft({
      key: { accountId: "acc-1", draftId: "local-draft" },
      expectedRevision: null,
      content: {
        to: ["ada@example.com"],
        cc: [],
        bcc: [],
        subject: "Unsent",
        editableHtml: "<p>Still here</p>",
        quotedHtml: "",
      },
    });
    expect(draft.status).toBe("saved");

    const hydrated: string[][] = [];
    const engine = createMailEngine({
      store,
      source: expiredHistorySource({
        // The new scan covers mail from 4000 on and no longer lists the
        // message deleted on another device.
        enumerated: [gmailPatch("kept", 5000), gmailPatch("arrived", 7000)],
        onHydrate: (ids) => hydrated.push(ids),
      }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 10_000 }),
    });
    await engine.requestSync(["acc-1"]);
    for (let pass = 0; pass < 4; pass++)
      await engine.runUntil(Date.now() + 2000);

    const inbox = await store.readMailboxView(inboxQuery);
    const ids = inbox.view.conversations.map((row) => row.key.conversationId);
    expect(hydrated).toEqual([["deleted-elsewhere"]]);
    expect(ids.sort()).toEqual(["c-arrived", "c-kept", "c-older-than-scan"]);
    const readBack = await store.readDraft({
      accountId: "acc-1",
      draftId: "local-draft",
    });
    expect(readBack).toMatchObject({ status: "found" });
    await engine.close();
  });

  it("removes a message whose content the provider reports as gone", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "google" });
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session,
        requestId: "seed",
        from: { streamId: "primary", generation: "g1", checkpoint: null },
        to: { streamId: "primary", generation: "g1", checkpoint: "h1" },
        changes: [gmailPatch("gone", 5000)],
        requiredHydration: [],
        roundComplete: true,
      },
    });
    const engine = createMailEngine({
      store,
      source: expiredHistorySource({ enumerated: [], resets: false }),
      executor: {
        async execute() {
          return { status: "uncertain", receiptId: null };
        },
        async inspect() {
          return { status: "uncertain", receiptId: null };
        },
      },
      runtime: createHostRuntime({ nowMs: () => 10_000 }),
    });
    await engine.ensureMessageContent({
      accountId: "acc-1",
      messageId: "gone",
    });
    await engine.runUntil(Date.now() + 2000);

    const inspection = await engine.inspect();
    expect(
      inspection.messages.find((row) => row.messageId === "gone")?.deleted,
    ).toBe(true);
    await engine.close();
  });
});

describe("opening a conversation the sync has not reached", () => {
  it("fetches a message the store has never seen when its content is asked for", async () => {
    const store = await createSqliteMailStore(createNodeSqliteDriver());
    await store.ensureAccount({ ...session, provider: "google" });
    const engine = createMailEngine({
      store,
      source: expiredHistorySource({
        enumerated: [],
        resets: false,
        hydrated: [gmailPatch("older", 1000)],
      }),
      executor: noExecutor,
      runtime: createHostRuntime({ nowMs: () => 10_000 }),
    });

    await engine.ensureMessageContent({
      accountId: "acc-1",
      messageId: "older",
    });
    await engine.runUntil(Date.now() + 2000);

    const conversation = await store.readConversation(
      { accountId: "acc-1", conversationId: "c-older" },
      { after: null, pageSize: 50 },
    );
    expect(conversation.view.messages).toMatchObject([
      {
        key: { accountId: "acc-1", messageId: "older" },
        content: { status: "available", text: "body of older" },
      },
    ]);
    await engine.close();
  });
});

function expiredHistorySource(input: {
  enumerated: Array<Extract<ProviderChange, { kind: "message_patch" }>>;
  resets?: boolean;
  onHydrate?: (messageIds: string[]) => void;
  /** Messages the provider has; any other asked for is gone. */
  hydrated?: Array<Extract<ProviderChange, { kind: "message_patch" }>>;
  onBegin?: (initial: boolean | undefined) => void;
}): MailboxSource {
  let reset = input.resets !== false;
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
          scopes: [{ id: "primary", kind: "account", folderId: null }],
          nextPage: null,
        },
      };
    },
    async beginBootstrap({ initial }) {
      input.onBegin?.(initial);
      return {
        status: "ok",
        value: {
          bootstrapId: "boot",
          enumerationToken: "page-1",
          catchUpFrom: null,
        },
      };
    },
    async enumerate() {
      return {
        status: "ok",
        value: {
          bootstrapId: "boot",
          scopeId: "primary",
          changes: input.enumerated,
          requiredHydration: [],
          bodies: [],
          nextPage: null,
          catchUpFrom: {
            streamId: "primary",
            generation: "g1",
            checkpoint: "h2",
          },
        },
      };
    },
    async readChanges({ position, requestId }) {
      // Gmail answers 404 for a history id it no longer keeps.
      if (reset) {
        reset = false;
        return { status: "reset_required", scopeId: "primary" };
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
      input.onHydrate?.(keys.map((key) => key.messageId));
      const found = (input.hydrated ?? []).filter((patch) =>
        keys.some((key) => key.messageId === patch.key.messageId),
      );
      return {
        status: "ok",
        value: {
          changes: found,
          bodies: found.map((patch) => ({
            key: patch.key,
            version: patch.reference.version,
            html: null,
            text: `body of ${patch.key.messageId}`,
          })),
          unresolved: keys
            .filter((key) =>
              found.every((patch) => patch.key.messageId !== key.messageId),
            )
            .map((key) => ({ key, reason: "not_found" as const })),
        },
      };
    },
    async readConversationMembership() {
      return { status: "ok", value: { status: "not_found" } };
    },
    async search() {
      return { status: "unsupported" };
    },
    async readAttachment() {
      return { status: "not_found" };
    },
  };
}

function gmailPatch(
  messageId: string,
  receivedAtMs: number,
): Extract<ProviderChange, { kind: "message_patch" }> {
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
      subject: messageId,
      preview: messageId,
      from: "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs,
      read: false,
      starred: false,
      folderId: null,
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
