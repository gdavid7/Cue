import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const T0 = 1_800_000_000_000;
const INBOX: MailPredicate = { kind: "mailbox", mailbox: "inbox" };
// Not served by a conversation index, so it takes the filtered count.
const UNREAD_INBOX: MailPredicate = {
  kind: "all",
  predicates: [INBOX, { kind: "read", value: false }],
};

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// All inboxes lists a message delivered to two of the user's accounts once,
// so its counts must not count the hidden copy.
describe("counts across accounts", () => {
  it("count a message in two accounts once, unread when any copy is", async () => {
    const store = await open();
    await write(store, "a", [
      patch("a", "m1", { conversation: "c1", internetMessageId: "<Shared@X>" }),
      patch("a", "m2", { conversation: "c2", internetMessageId: "<own@x>" }),
    ]);
    await write(store, "b", [
      patch("b", "m1", {
        conversation: "c9",
        internetMessageId: "shared@x",
        read: true,
      }),
    ]);

    expect(await counts(store, ["a", "b"], INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
    expect(await viewCounts(store, ["a", "b"], INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
    expect(await counts(store, ["a", "b"], UNREAD_INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
    // Each account alone still counts its own copy.
    expect(await counts(store, ["b"], INBOX)).toEqual({
      matching: 1,
      unread: 0,
    });
  });

  it("count one account's conversations apart, even when they share a Message-ID", async () => {
    const store = await open();
    await write(store, "a", [
      patch("a", "m1", { conversation: "c1", internetMessageId: "<dup@x>" }),
      patch("a", "m2", { conversation: "c2", internetMessageId: "<dup@x>" }),
    ]);
    await write(store, "b", [
      patch("b", "m1", { conversation: "c1", internetMessageId: "<dup@x>" }),
    ]);

    expect(await counts(store, ["a", "b"], INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
  });

  it("count messages without a Message-ID one by one", async () => {
    const store = await open();
    await write(store, "a", [patch("a", "m1", { conversation: "c1" })]);
    await write(store, "b", [patch("b", "m1", { conversation: "c1" })]);

    expect(await counts(store, ["a", "b"], INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
  });

  // The list pairs each account's copies newest first, so the second pair
  // here is unread through b's copy though a's is read.
  it("pair one account's copies with another's by rank, unread through either", async () => {
    const store = await open();
    await write(store, "a", [
      patch("a", "m1", {
        conversation: "c1",
        at: T0 + 2,
        internetMessageId: "<dup@x>",
      }),
      patch("a", "m2", {
        conversation: "c2",
        at: T0 + 1,
        internetMessageId: "<dup@x>",
        read: true,
      }),
    ]);
    await write(store, "b", [
      patch("b", "m1", {
        conversation: "c1",
        at: T0 + 2,
        internetMessageId: "<dup@x>",
        read: true,
      }),
      patch("b", "m2", {
        conversation: "c2",
        at: T0 + 1,
        internetMessageId: "<dup@x>",
      }),
    ]);

    expect(await counts(store, ["a", "b"], INBOX)).toEqual({
      matching: 2,
      unread: 2,
    });
  });

  it("follow the conversation's latest message as it changes", async () => {
    const store = await open();
    await write(store, "a", [
      patch("a", "m1", { conversation: "c1", internetMessageId: "<first@x>" }),
    ]);
    await write(store, "b", [
      patch("b", "m1", { conversation: "c1", internetMessageId: "<later@x>" }),
    ]);
    expect(await counts(store, ["a", "b"], INBOX)).toMatchObject({
      matching: 2,
    });

    // A reply in a's conversation that b also got: now the same message.
    await write(store, "a", [
      patch("a", "m2", {
        conversation: "c1",
        at: T0 + 1000,
        internetMessageId: "<Later@X>",
      }),
    ]);
    expect(await counts(store, ["a", "b"], INBOX)).toMatchObject({
      matching: 1,
    });

    // A draft reply never stands for the conversation.
    await write(store, "a", [
      patch("a", "d1", { conversation: "c1", at: T0 + 2000, roles: ["draft"] }),
    ]);
    expect(await counts(store, ["a", "b"], INBOX)).toMatchObject({
      matching: 1,
    });
  });

  it("key mail stored before the keys existed, once migrated", async () => {
    const driver = createNodeSqliteDriver();
    const store = await open(driver);
    await write(store, "a", [
      patch("a", "m1", { conversation: "c1", internetMessageId: "<s@x>" }),
    ]);
    await write(store, "b", [
      patch("b", "m1", { conversation: "c1", internetMessageId: "<S@x>" }),
    ]);
    // The mailbox as a build before message keys left it.
    await driver.write(async (tx) => {
      for (const event of ["insert", "delete", "update"])
        await tx.exec(`DROP TRIGGER conversation_message_keys_after_${event}`);
      for (const event of ["insert", "delete"])
        await tx.exec(`DROP TRIGGER shared_message_copies_after_${event}`);
      await tx.exec("DROP TABLE shared_message_copies");
      await tx.exec("DROP TABLE conversation_message_keys");
      await tx.exec("ALTER TABLE effective_messages DROP COLUMN message_key");
      await tx.exec("DELETE FROM schema_migrations WHERE id = 17");
    });

    const migrated = await createSqliteMailStore(driver);

    expect(await counts(migrated, ["a", "b"], INBOX)).toMatchObject({
      matching: 1,
    });
  });

  // A sync or a mark-read rewrites a message through an upsert, whose
  // conflict policy reaches into the triggers it fires; a message in three
  // accounts once made every such write fail and roll back.
  it.each([
    // a's and c's copies stay one row; b's, now another message, its own.
    [
      "three accounts",
      ["a", "b", "c"],
      [
        ["a", "c1"],
        ["b", "c1"],
        ["c", "c1"],
      ],
      2,
    ],
    // a's two conversations stay apart; b's is another message now.
    [
      "two conversations in one account and one in another",
      ["a", "b"],
      [
        ["a", "c1"],
        ["a", "c2"],
        ["b", "c1"],
      ],
      3,
    ],
  ] as const)("rewrite a message whose copies are in %s", async (_, accountIds, copies, rows) => {
    const store = await open(createNodeSqliteDriver(), [...accountIds]);
    for (const [index, [account, conversation]] of copies.entries())
      await write(store, account, [
        patch(account, `m${index}`, {
          conversation,
          internetMessageId: "<many@x>",
        }),
      ]);

    // Read on one copy, then the message leaves one conversation's inbox.
    await write(store, "a", [
      patch("a", "m0", {
        conversation: "c1",
        internetMessageId: "<many@x>",
        read: true,
        version: "2",
      }),
    ]);
    await write(store, "b", [
      patch("b", `m${copies.length - 1}`, {
        conversation: "c1",
        internetMessageId: "<other@x>",
        version: "2",
      }),
    ]);

    expect(await counts(store, [...accountIds], INBOX)).toMatchObject({
      matching: rows,
    });
  });

  it("count each account's drafts, as Drafts lists each", async () => {
    const store = await open();
    for (const account of ["a", "b"])
      await write(store, account, [
        patch(account, "m1", {
          conversation: "c1",
          internetMessageId: "<asked@x>",
        }),
        patch(account, "d1", {
          conversation: "c1",
          at: T0 + 1000,
          roles: ["draft"],
        }),
      ]);

    expect(
      await counts(store, ["a", "b"], { kind: "role", role: "draft" }),
    ).toEqual({ matching: 2, unread: 2 });
  });
});

async function open(
  driver = createNodeSqliteDriver(),
  accountIds = ["a", "b"],
) {
  const store = await createSqliteMailStore(driver);
  cleanups.push(() => store.close());
  for (const accountId of accountIds)
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g",
    });
  return store;
}

async function write(
  store: MailStore,
  accountId: string,
  changes: ProviderChange[],
) {
  expect(
    await store.applyHydration({
      session: { accountId, generation: "g" },
      requestId: `test-${accountId}`,
      changes,
      bodies: [],
    }),
  ).toMatchObject({ status: "committed" });
}

async function counts(
  store: MailStore,
  accountIds: string[],
  predicate: MailPredicate,
) {
  const { view } = await store.readMailboxCounts({
    accountIds,
    targets: [{ id: "t", predicate }],
  });
  const [count] = view.counts;
  return {
    matching: count?.matchingConversations,
    unread: count?.unreadConversations,
  };
}

async function viewCounts(
  store: MailStore,
  accountIds: string[],
  predicate: MailPredicate,
) {
  const { view } = await store.readMailboxView({
    accountIds,
    predicate,
    order: "newest_first",
    pageSize: 25,
    after: null,
  });
  return {
    matching: view.counts.matchingConversations,
    unread: view.counts.unreadConversations,
  };
}

function patch(
  accountId: string,
  id: string,
  {
    conversation,
    at = T0,
    read = false,
    roles = ["inbox"],
    internetMessageId,
    version = "1",
  }: {
    conversation: string;
    at?: number;
    read?: boolean;
    roles?: Array<"inbox" | "draft">;
    internetMessageId?: string;
    version?: string;
  },
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId, messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: conversation,
      version,
    },
    fields: {
      subject: "Plan",
      preview: "",
      from: "ana@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: at,
      read,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      roles,
      hasAttachments: false,
      ...(internetMessageId ? { internetMessageId } : {}),
    },
  };
}
