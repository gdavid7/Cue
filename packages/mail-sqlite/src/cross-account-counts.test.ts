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

async function open() {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  cleanups.push(() => store.close());
  for (const accountId of ["a", "b"])
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
  }: {
    conversation: string;
    at?: number;
    read?: boolean;
    roles?: Array<"inbox" | "draft">;
    internetMessageId?: string;
  },
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId, messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: conversation,
      version: "1",
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
