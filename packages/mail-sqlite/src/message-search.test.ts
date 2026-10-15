import { describe, expect, it } from "vitest";
import type {
  MailPredicate,
  MessageSearchQuery,
} from "@inboxzero/mail-core/queries";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ACCOUNT = "acc-1";
const DAY = 86_400_000;
const T0 = Date.parse("2026-10-01T12:00:00Z");
const all: MailPredicate = { kind: "mailbox", mailbox: "all" };

describe("readMessageSearch", () => {
  it("returns the matching message of a thread, not its newest one", async () => {
    const store = await storeWith([
      message("alice-1", "c1", { from: "Alice <alice@example.com>", at: T0 }),
      message("my-reply", "c1", {
        from: "me@example.com",
        at: T0 + DAY,
        roles: ["sent"],
      }),
    ]);

    const page = await store.readMessageSearch(
      query({ fromAddress: "alice@example.com" }),
    );

    expect(page.messages.map((m) => m.messageId)).toEqual(["alice-1"]);
    expect(page.messages[0]).toMatchObject({
      from: "Alice <alice@example.com>",
      receivedAtMs: T0,
      conversationId: "c1",
    });
  });

  it("matches the sender's address exactly", async () => {
    const store = await storeWith([
      message("bare", "c1", { from: "jobs@acme.com", at: T0 }),
      message("named", "c2", { from: "Acme <jobs@acme.com>", at: T0 + 1 }),
      message("longer", "c3", { from: "xjobs@acme.com", at: T0 + 2 }),
      message("underscore", "c4", { from: "jobsXacme.com", at: T0 + 3 }),
    ]);

    const page = await store.readMessageSearch(
      query({ fromAddress: "jobs@acme.com" }),
    );

    expect(page.messages.map((m) => m.messageId)).toEqual(["named", "bare"]);
  });

  it("returns drafts for in:drafts and only sent mail for in:sent", async () => {
    const store = await storeWith([
      message("received", "c1", { at: T0 }),
      message("draft", "c1", { at: T0 + 1, roles: ["draft"] }),
      message("sent", "c2", { at: T0 + 2, roles: ["sent"] }),
    ]);

    const drafts = await store.readMessageSearch(
      query({ predicate: { kind: "mailbox", mailbox: "drafts" } }),
    );
    const sent = await store.readMessageSearch(
      query({ predicate: { kind: "mailbox", mailbox: "sent" } }),
    );

    expect(drafts.messages.map((m) => m.messageId)).toEqual(["draft"]);
    expect(sent.messages.map((m) => m.messageId)).toEqual(["sent"]);
  });

  it("filters read state and dates per message", async () => {
    const store = await storeWith([
      message("old-unread", "c1", { at: T0, read: false }),
      message("new-read", "c1", { at: T0 + 2 * DAY, read: true }),
    ]);

    const unread = await store.readMessageSearch(
      query({
        predicate: {
          kind: "all",
          predicates: [all, { kind: "read", value: false }],
        },
      }),
    );
    const recent = await store.readMessageSearch(
      query({
        predicate: {
          kind: "all",
          predicates: [
            all,
            { kind: "received", afterMs: T0 + DAY, beforeMs: null },
          ],
        },
      }),
    );

    expect(unread.messages.map((m) => m.messageId)).toEqual(["old-unread"]);
    expect(recent.messages.map((m) => m.messageId)).toEqual(["new-read"]);
  });

  it("leaves spam and trash out of a whole-mailbox search", async () => {
    const store = await storeWith([
      message("kept", "c1", { at: T0 }),
      message("spam", "c2", { at: T0 + 1, roles: ["spam"] }),
      message("trash", "c3", { at: T0 + 2, roles: ["trash"] }),
    ]);

    const page = await store.readMessageSearch(query({}));

    expect(page.messages.map((m) => m.messageId)).toEqual(["kept"]);
  });

  it("counts messages toward the page size and pages through the rest", async () => {
    const store = await storeWith([
      message("a1", "c1", { at: T0 + 3 }),
      message("a2", "c1", { at: T0 + 2 }),
      message("b1", "c2", { at: T0 + 1 }),
    ]);

    const first = await store.readMessageSearch(query({ pageSize: 2 }));
    const second = await store.readMessageSearch(
      query({ pageSize: 2, after: first.nextPage }),
    );

    expect(first.messages.map((m) => m.messageId)).toEqual(["a1", "a2"]);
    expect(first.nextPage).not.toBeNull();
    expect(second.messages.map((m) => m.messageId)).toEqual(["b1"]);
    expect(second.nextPage).toBeNull();
  });

  it("matches words against each message, not the thread", async () => {
    const store = await storeWith([
      message("zebra", "c1", { at: T0 }),
      message("other", "c1", { at: T0 + 1 }),
    ]);

    const page = await store.readMessageSearch(
      query({
        predicate: {
          kind: "all",
          predicates: [
            all,
            { kind: "text", field: "any", value: "zebra", match: "term" },
          ],
        },
      }),
    );

    expect(page.messages.map((m) => m.messageId)).toEqual(["zebra"]);
  });

  it("keeps each message's own labels and flags", async () => {
    const store = await storeWith([
      message("plain", "c1", { at: T0, labelIds: [] }),
      message("labelled", "c1", {
        at: T0 + 1,
        labelIds: ["Label_7"],
        read: false,
        starred: true,
      }),
    ]);

    const page = await store.readMessageSearch(query({}));

    expect(page.messages).toEqual([
      expect.objectContaining({
        messageId: "labelled",
        labelIds: ["Label_7"],
        read: false,
        starred: true,
      }),
      expect.objectContaining({
        messageId: "plain",
        labelIds: [],
        read: true,
        starred: false,
      }),
    ]);
  });
});

function query(overrides: Partial<MessageSearchQuery>): MessageSearchQuery {
  return {
    accountId: ACCOUNT,
    predicate: all,
    fromAddress: null,
    pageSize: 20,
    after: null,
    ...overrides,
  };
}

function message(
  messageId: string,
  conversationId: string,
  fields: {
    at: number;
    from?: string;
    read?: boolean;
    starred?: boolean;
    labelIds?: string[];
    roles?: Array<"inbox" | "sent" | "draft" | "trash" | "spam">;
  },
) {
  return {
    kind: "message_patch" as const,
    key: { accountId: ACCOUNT, messageId },
    reference: {
      provider: "google" as const,
      messageId,
      conversationId,
      version: "1",
    },
    fields: {
      subject: `Subject ${messageId}`,
      preview: `Preview ${messageId}`,
      from: fields.from ?? "ada@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: fields.at,
      read: fields.read ?? true,
      starred: fields.starred ?? false,
      folderId: null,
      labelIds: fields.labelIds ?? [],
      categoryIds: [],
      roles: fields.roles ?? ["inbox"],
      hasAttachments: false,
    },
  };
}

async function storeWith(changes: ReturnType<typeof message>[]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  await store.ensureAccount({
    accountId: ACCOUNT,
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: ACCOUNT, generation: "g1" },
      requestId: "boot",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes,
      requiredHydration: [],
      roundComplete: true,
    },
  });
  return store;
}
