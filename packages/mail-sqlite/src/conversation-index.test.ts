import { describe, expect, it } from "vitest";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";
import {
  migrateConversationIndex,
  migrateMembershipIndex,
} from "./conversation-index";
import type { SqlTransaction, SqliteDriver } from "./driver";
import type {
  MailboxCountsQuery,
  MailPredicate,
} from "@inboxzero/mail-core/queries";

describe("transactional conversation index", () => {
  it("shows the same conversation preview for equivalent inbox filters", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        await insertMessage(tx, "inbound", "conversation", 1, 0);
        await insertMessage(tx, "reply", "conversation", 2, 1);
        await tx.execute(
          `UPDATE effective_messages SET roles_json = '["sent"]', in_inbox = 0,
           in_sent = 1, preview = 'My latest reply', from_address = 'me@example.com'
           WHERE message_id = 'reply'`,
        );
      });
      const query = {
        accountIds: ["a"],
        predicate: { kind: "role" as const, role: "inbox" as const },
        order: "newest_first" as const,
        pageSize: 25,
        after: null,
      };
      const indexed = await store.readMailboxView(query);
      const composed = await store.readMailboxView({
        ...query,
        predicate: { kind: "all", predicates: [query.predicate] },
      });
      expect(indexed).toEqual(composed);
      expect(indexed.view.conversations[0]).toMatchObject({
        preview: "My latest reply",
        from: "me@example.com",
        unread: true,
      });
    } finally {
      await store.close();
    }
  });

  it("tracks role counts, moves and rollback without a separate publication", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 1, 0);
        await insertMessage(tx, "m2", "c1", 2, 1);
      });
      const query = {
        accountIds: ["a"],
        predicate: { kind: "role" as const, role: "inbox" as const },
        order: "newest_first" as const,
        pageSize: 25,
        after: null,
      };
      const initial = await store.readMailboxView(query);
      expect(initial.view.counts).toMatchObject({
        matchingConversations: 1,
        unreadConversations: 1,
      });
      expect(initial.view.conversations[0]?.latestMessageAtMs).toBe(2);
      await expect(
        driver.write(async (tx) => {
          await tx.execute("DELETE FROM effective_messages");
          throw new Error("simulated interruption");
        }),
      ).rejects.toThrow("simulated interruption");
      expect((await store.readMailboxView(query)).view).toEqual(initial.view);
      await driver.write((tx) =>
        tx.execute(
          "UPDATE effective_messages SET conversation_id = 'c2' WHERE message_id = 'm2'",
        ),
      );
      expect((await store.readMailboxView(query)).view.counts).toMatchObject({
        matchingConversations: 2,
        unreadConversations: 1,
      });
      await driver.write((tx) =>
        tx.execute(
          "UPDATE effective_messages SET in_inbox = 0, roles_json = '[]' WHERE message_id = 'm1'",
        ),
      );
      const archived = await store.readMailboxView(query);
      expect(archived.view.counts).toMatchObject({
        matchingConversations: 1,
        unreadConversations: 0,
      });
      expect(
        archived.view.conversations.map((row) => row.key.conversationId),
      ).toEqual(["c2"]);
      await driver.write((tx) => tx.execute("DELETE FROM effective_messages"));
      expect(
        (await store.readMailboxView(query)).view.counts.matchingConversations,
      ).toBe(0);
    } finally {
      await store.close();
    }
  });

  it("serves label, category, folder, and draft views like the unindexed filter", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 1, 0, {
          labels: ["Label_1"],
          categories: ["CATEGORY_UPDATES"],
          folder: "f1",
        });
        await insertMessage(tx, "m2", "c1", 3, 1, { labels: ["Label_1"] });
        await insertMessage(tx, "m3", "c2", 2, 1, {
          labels: ["Label_1", "Label_2"],
          folder: "f1",
        });
        await insertMessage(tx, "m4", "c3", 4, 1, { draft: true });
      });
      const predicates = [
        { kind: "membership", membership: "label", id: "Label_1" },
        { kind: "membership", membership: "label", id: "Label_2" },
        {
          kind: "membership",
          membership: "label",
          id: "Label_1",
          accountId: "a",
        },
        { kind: "membership", membership: "category", id: "CATEGORY_UPDATES" },
        { kind: "membership", membership: "folder", id: "f1" },
        { kind: "role", role: "draft" },
      ] as const;
      const compare = async () => {
        for (const predicate of predicates) {
          const query = {
            accountIds: ["a"],
            predicate,
            order: "newest_first" as const,
            pageSize: 25,
            after: null,
          };
          const composed = await store.readMailboxView({
            ...query,
            predicate: { kind: "all", predicates: [predicate] },
          });
          expect(await store.readMailboxView(query)).toEqual(composed);
        }
      };
      await compare();
      await driver.write((tx) =>
        tx.execute(
          "UPDATE effective_messages SET label_ids_json = '[]' WHERE message_id = 'm1'",
        ),
      );
      await compare();
      const label = await store.readMailboxView({
        accountIds: ["a"],
        predicate: { kind: "membership", membership: "label", id: "Label_1" },
        order: "newest_first",
        pageSize: 25,
        after: null,
      });
      expect(label.view.counts).toMatchObject({
        matchingConversations: 2,
        unreadConversations: 0,
      });
    } finally {
      await store.close();
    }
  });

  it("counts every target for all requested accounts in one read", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      for (const accountId of ["a", "b"]) {
        await store.ensureAccount({
          accountId,
          provider: "google",
          generation: "g",
        });
      }
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 1, 0, {
          labels: ["Label_1"],
          categories: ["CATEGORY_UPDATES"],
          folder: "f1",
        });
        await insertMessage(tx, "m2", "c1", 3, 1, { labels: ["Label_1"] });
        await insertMessage(tx, "m3", "c2", 2, 1, {
          labels: ["Label_1"],
          folder: "f1",
        });
        await insertMessage(tx, "m4", "c3", 4, 0, { draft: true });
        await insertMessage(tx, "m5", "c4", 5, 0, { labels: ["Label_2"] });
        // Only the read message is snoozed, so the snoozed view shows the
        // conversation but not as unread.
        await insertMessage(tx, "m6", "c5", 6, 1, {
          snoozedUntil: Date.now() + 60_000,
        });
        await insertMessage(tx, "m7", "c5", 7, 0);
        await insertMessage(tx, "m8", "c1", 8, 0, {
          account: "b",
          labels: ["Label_1"],
        });
      });
      const targets: MailboxCountsQuery["targets"] = [
        { id: "inbox", predicate: { kind: "role", role: "inbox" } },
        { id: "draft", predicate: { kind: "role", role: "draft" } },
        {
          id: "label",
          predicate: { kind: "membership", membership: "label", id: "Label_1" },
        },
        {
          id: "label-account-a",
          predicate: {
            kind: "membership",
            membership: "label",
            id: "Label_1",
            accountId: "a",
          },
        },
        {
          id: "category",
          predicate: {
            kind: "membership",
            membership: "category",
            id: "CATEGORY_UPDATES",
          },
        },
        {
          id: "folder",
          predicate: { kind: "membership", membership: "folder", id: "f1" },
        },
        {
          id: "unread-inbox",
          predicate: {
            kind: "all",
            predicates: [
              { kind: "role", role: "inbox" },
              { kind: "read", value: false },
            ],
          },
        },
        { id: "archive", predicate: { kind: "mailbox", mailbox: "archive" } },
        { id: "snoozed", predicate: { kind: "mailbox", mailbox: "snoozed" } },
      ];

      const result = await store.readMailboxCounts({
        accountIds: ["a", "b"],
        targets,
      });

      expect(result.view.counts).toEqual([
        { id: "inbox", matchingConversations: 5, unreadConversations: 4 },
        { id: "draft", matchingConversations: 1, unreadConversations: 1 },
        { id: "label", matchingConversations: 3, unreadConversations: 2 },
        {
          id: "label-account-a",
          matchingConversations: 2,
          unreadConversations: 1,
        },
        { id: "category", matchingConversations: 1, unreadConversations: 1 },
        { id: "folder", matchingConversations: 2, unreadConversations: 1 },
        {
          id: "unread-inbox",
          matchingConversations: 4,
          unreadConversations: 4,
        },
        { id: "archive", matchingConversations: 1, unreadConversations: 1 },
        { id: "snoozed", matchingConversations: 1, unreadConversations: 0 },
      ]);
    } finally {
      await store.close();
    }
  });

  it("backfills memberships for an existing mailbox once", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        for (const event of ["insert", "delete", "update"]) {
          await tx.exec(`DROP TRIGGER effective_memberships_after_${event}`);
        }
        await tx.exec(
          "DROP TABLE effective_message_memberships; DELETE FROM schema_migrations WHERE id = 3;",
        );
        await insertMessage(tx, "m1", "c1", 1, 0, { labels: ["Label_1"] });
        await migrateMembershipIndex(tx);
        await migrateMembershipIndex(tx);
      });
      const rows = await driver.read((tx) =>
        tx.query(
          "SELECT kind, membership_id, message_id, read FROM effective_message_memberships",
        ),
      );
      expect(rows).toEqual([
        {
          kind: "label",
          membership_id: "Label_1",
          message_id: "m1",
          read: 0,
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("pages oldest first, from the role index and the unindexed filter alike", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 30, 0);
        await insertMessage(tx, "m2", "c2", 10, 0);
        await insertMessage(tx, "m3", "c3", 20, 1);
        await insertMessage(tx, "m4", "c4", 20, 0);
      });
      const inbox = { kind: "role" as const, role: "inbox" as const };
      for (const predicate of [
        inbox,
        { kind: "all" as const, predicates: [inbox] },
      ]) {
        const query = {
          accountIds: ["a"],
          predicate,
          order: "oldest_first" as const,
          pageSize: 2,
          after: null,
        };
        const first = await store.readMailboxView(query);
        expect(
          first.view.conversations.map((row) => row.key.conversationId),
        ).toEqual(["c2", "c4"]);
        expect(first.view.nextPage).not.toBeNull();
        const second = await store.readMailboxView({
          ...query,
          after: first.view.nextPage,
        });
        expect(
          second.view.conversations.map((row) => row.key.conversationId),
        ).toEqual(["c3", "c1"]);
        expect(second.view.nextPage).toBeNull();
      }

      const unread = await store.readMailboxView({
        accountIds: ["a"],
        predicate: {
          kind: "all",
          predicates: [inbox, { kind: "read", value: false }],
        },
        order: "oldest_first",
        pageSize: 10,
        after: null,
      });
      expect(
        unread.view.conversations.map((row) => row.key.conversationId),
      ).toEqual(["c2", "c4", "c1"]);
    } finally {
      await store.close();
    }
  });

  it("reads named conversations, of one account, through other conditions", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      for (const accountId of ["a", "b"])
        await store.ensureAccount({
          accountId,
          provider: "google",
          generation: "g",
        });
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 10, 1);
        await insertMessage(tx, "m2", "c1", 20, 0);
        await insertMessage(tx, "m3", "c2", 30, 1);
        await insertMessage(tx, "m4", "c3", 40, 0);
        await insertMessage(tx, "m5", "c1", 50, 0, { account: "b" });
      });
      const view = await store.readMailboxView({
        accountIds: ["a", "b"],
        predicate: {
          kind: "all",
          predicates: [
            { kind: "role", role: "inbox" },
            { kind: "read", value: false },
            { kind: "conversation", ids: ["c1", "c2"], accountId: "a" },
          ],
        },
        order: "oldest_first",
        pageSize: 10,
        after: null,
      });
      // c2 has nothing unread, c3 isn't named, and b's c1 is another account's.
      expect(
        view.view.conversations.map((row) => [
          row.key.accountId,
          row.key.conversationId,
          row.latestMessageAtMs,
        ]),
      ).toEqual([["a", "c1", 20]]);
    } finally {
      await store.close();
    }
  });

  it("reads every account's conversations by their key, through its index", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      for (const accountId of ["a", "b"])
        await store.ensureAccount({
          accountId,
          provider: "google",
          generation: "g",
        });
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 10, 0, {
          messageKey: "shared@example.com",
        });
        // In b the copy was read and a draft started: still b's key.
        await insertMessage(tx, "m2", "c9", 10, 1, {
          account: "b",
          roles: [],
          messageKey: "shared@example.com",
        });
        await insertMessage(tx, "m3", "c9", 30, 1, {
          account: "b",
          draft: true,
        });
        // A reply moves c2's key on, so it isn't the shared message's.
        await insertMessage(tx, "m4", "c2", 10, 1, {
          messageKey: "shared@example.com",
        });
        await insertMessage(tx, "m5", "c2", 40, 1, {
          roles: ["sent"],
          messageKey: "reply@example.com",
        });
        // Normalising "<<a@b>>" once leaves "<a@b>", which is the key.
        await insertMessage(tx, "m6", "c3", 50, 0, { messageKey: "<a@b>" });
      });
      const read = (predicate: MailPredicate) =>
        store
          .readMailboxView({
            accountIds: ["a", "b"],
            predicate,
            order: "newest_first",
            pageSize: 10,
            after: null,
          })
          .then((view) =>
            view.view.conversations
              .map((row) => `${row.key.accountId}:${row.key.conversationId}`)
              .sort(),
          );
      const keyed = (ids: string[], accountId?: string): MailPredicate => ({
        kind: "internet_message_id",
        ids,
        ...(accountId ? { accountId } : {}),
      });

      expect(await read(keyed(["shared@example.com"]))).toEqual([
        "a:c1",
        "b:c9",
      ]);
      expect(await read(keyed(["shared@example.com"], "b"))).toEqual(["b:c9"]);
      expect(await read(keyed(["<a@b>"]))).toEqual(["a:c3"]);
      expect(await read(keyed(["a@b"]))).toEqual([]);
      expect(await read(keyed([]))).toEqual([]);
      // Inside another condition it reads the same.
      expect(
        await read({
          kind: "all",
          predicates: [
            { kind: "read", value: false },
            keyed(["shared@example.com"]),
          ],
        }),
      ).toEqual(["a:c1"]);
    } finally {
      await store.close();
    }
  });

  it("does not count archived unread mail as inbox unread", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        await insertMessage(tx, "archived", "archived-thread", 1, 0, {
          roles: [],
        });
        await insertMessage(tx, "inbox-read", "mixed-thread", 2, 1);
        await insertMessage(tx, "archived-unread", "mixed-thread", 3, 0, {
          roles: [],
        });
        await insertMessage(tx, "archive-label", "archive-label-thread", 4, 0, {
          labels: ["ARCHIVE"],
        });
        await insertMessage(tx, "left-inbox", "left-thread", 5, 0);
        await tx.execute(
          "UPDATE effective_messages SET in_inbox = 0 WHERE message_id = 'left-inbox'",
        );
        await insertMessage(tx, "inbox-unread", "open-thread", 6, 0);
      });
      const counts = await store.readMailboxCounts({
        accountIds: ["a"],
        targets: [{ id: "INBOX", predicate: { kind: "role", role: "inbox" } }],
      });
      expect(counts.view.counts).toEqual([
        { id: "INBOX", matchingConversations: 2, unreadConversations: 1 },
      ]);
    } finally {
      await store.close();
    }
  });

  it("keeps the role index equal to a full rebuild through inserts, updates and deletes", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await store.ensureAccount({
        accountId: "b",
        provider: "google",
        generation: "g",
      });
      // Each aggregated column changes alone in a conversation nothing else
      // touches, so skipping any one rebuild leaves a stale row behind.
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "received", 10, 1);
        await insertMessage(tx, "m2", "received", 30, 0);
        await insertMessage(tx, "m3", "read", 20, 0);
        await insertMessage(tx, "m4", "starred", 40, 1);
        await insertMessage(tx, "m5", "roles", 50, 0, {
          roles: ["inbox", "sent"],
        });
        await insertMessage(tx, "m6", "labels", 60, 0, {
          labels: ["ARCHIVE"],
        });
        await insertMessage(tx, "m7", "in-inbox", 70, 0);
        await insertMessage(tx, "m8", "moved-from", 80, 0);
        await insertMessage(tx, "m9", "moved-to", 90, 0);
        await insertMessage(tx, "m10", "account", 100, 0, { account: "b" });
        await insertMessage(tx, "m11", "renamed", 110, 0);
        await insertMessage(tx, "m12", "deleted", 120, 0);
        await insertMessage(tx, "m13", "deleted", 5, 1);
        // An older, read insert must not lower the newer unread message's row.
        await insertMessage(tx, "m14", "folded", 200, 0);
        await insertMessage(tx, "m15", "folded", 150, 1);
        for (const [assignment, messageId] of [
          ["received_at_ms = 15", "m2"],
          ["read = 1", "m3"],
          ["starred = 1", "m4"],
          [`roles_json = '["sent"]'`, "m5"],
          ["label_ids_json = '[]'", "m6"],
          ["in_inbox = 0", "m7"],
          ["conversation_id = 'moved-to'", "m8"],
          ["account_id = 'a'", "m10"],
          ["subject = 'Renamed'", "m11"],
        ]) {
          await tx.execute(
            `UPDATE effective_messages SET ${assignment} WHERE message_id = ?`,
            [messageId],
          );
        }
        await tx.execute(
          "DELETE FROM effective_messages WHERE message_id = 'm12'",
        );
      });
      const maintained = await roleIndexRows(driver);

      await driver.write(async (tx) => {
        for (const event of ["insert", "delete", "update"]) {
          await tx.exec(`DROP TRIGGER effective_conversations_after_${event}`);
        }
        await tx.exec(
          "DROP TABLE effective_role_conversations; DELETE FROM schema_migrations WHERE id = 2;",
        );
        await migrateConversationIndex(tx);
      });

      expect(maintained).toEqual(await roleIndexRows(driver));
      expect(maintained).toContainEqual({
        account_id: "a",
        conversation_id: "received",
        role: "inbox",
        latest_at_ms: 15,
        unread: 1,
        starred: 0,
      });
    } finally {
      await store.close();
    }
  });

  it("adds a message to a conversation without rereading the conversation", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      // Rebuilding on insert read every message in the conversation, which
      // made syncing an n-message conversation O(n^2).
      expect(await insertTriggerBody(driver)).not.toContain(
        "effective_messages",
      );
    } finally {
      await store.close();
    }
  });

  it("replaces rebuild-on-insert triggers when an existing mailbox opens", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      const conversation =
        "(account_id = NEW.account_id AND conversation_id = NEW.conversation_id)";
      await driver.write(async (tx) => {
        for (const event of ["insert", "update"]) {
          await tx.exec(`DROP TRIGGER effective_conversations_after_${event}`);
          await tx.exec(`
            CREATE TRIGGER effective_conversations_after_${event}
            AFTER ${event.toUpperCase()} ON effective_messages
            BEGIN
              DELETE FROM effective_role_conversations WHERE ${conversation};
              INSERT INTO effective_role_conversations(
                account_id, conversation_id, role, latest_at_ms, unread, starred
              )
              SELECT account_id, conversation_id, roles.value,
                     MAX(received_at_ms), MAX(1 - read), MAX(starred)
              FROM effective_messages, json_each(roles_json) AS roles
              WHERE ${conversation}
              GROUP BY account_id, conversation_id, roles.value;
            END;
          `);
        }
        await tx.execute("DELETE FROM schema_migrations WHERE id = 11");
      });
      expect(await insertTriggerBody(driver)).toContain("effective_messages");

      await createSqliteMailStore(driver);

      expect(await insertTriggerBody(driver)).not.toContain(
        "effective_messages",
      );
      await driver.write(async (tx) => {
        await insertMessage(tx, "m1", "c1", 20, 0);
        await insertMessage(tx, "m2", "c1", 10, 1);
        await tx.execute(
          "UPDATE effective_messages SET read = 1 WHERE message_id = 'm1'",
        );
      });
      expect(await roleIndexRows(driver)).toEqual([
        {
          account_id: "a",
          conversation_id: "c1",
          role: "inbox",
          latest_at_ms: 20,
          unread: 0,
          starred: 0,
        },
      ]);
    } finally {
      await store.close();
    }
  });

  it("backfills an existing mailbox once", async () => {
    const driver = createNodeSqliteDriver();
    const store = await createSqliteMailStore(driver);
    try {
      await store.ensureAccount({
        accountId: "a",
        provider: "google",
        generation: "g",
      });
      await driver.write(async (tx) => {
        for (const event of ["insert", "delete", "update"]) {
          await tx.exec(`DROP TRIGGER effective_conversations_after_${event}`);
        }
        await tx.exec(
          "DROP TABLE effective_role_conversations; DELETE FROM schema_migrations WHERE id = 2;",
        );
        await insertMessage(tx, "m1", "c1", 1, 0);
        await migrateConversationIndex(tx);
        await migrateConversationIndex(tx);
      });
      const rows = await driver.read((tx) =>
        tx.query(
          "SELECT conversation_id, unread FROM effective_role_conversations",
        ),
      );
      expect(rows).toEqual([{ conversation_id: "c1", unread: 1 }]);
    } finally {
      await store.close();
    }
  });
});

async function insertMessage(
  tx: SqlTransaction,
  id: string,
  conversation: string,
  received: number,
  read: number,
  options: {
    account?: string;
    labels?: string[];
    categories?: string[];
    folder?: string;
    draft?: boolean;
    snoozedUntil?: number;
    roles?: string[];
    /** The normalised Message-ID, as the store writes it. */
    messageKey?: string;
  } = {},
) {
  const roles = options.roles ?? (options.draft ? ["draft"] : ["inbox"]);
  const inInbox = roles.includes("inbox") ? 1 : 0;
  const inDraft = roles.includes("draft") ? 1 : 0;
  await tx.execute(
    `INSERT INTO effective_messages(
      account_id, message_id, conversation_id, subject, preview, from_address, to_json,
      received_at_ms, read, starred, folder_id, label_ids_json, category_ids_json, roles_json,
      in_inbox, in_sent, in_draft, in_trash, in_spam, has_attachments, snoozed_until_ms,
      pending_operation_ids_json, message_key
    ) VALUES (?, ?, ?, 'Subject', 'Preview', 'sender@example.com', '[]', ?, ?, 0,
      ?, ?, ?, ?, ?, 0, ?, 0, 0, 0, ?, '[]', ?)`,
    [
      options.account ?? "a",
      id,
      conversation,
      received,
      read,
      options.folder ?? null,
      JSON.stringify(options.labels ?? []),
      JSON.stringify(options.categories ?? []),
      JSON.stringify(roles),
      inInbox,
      inDraft,
      options.snoozedUntil ?? null,
      options.messageKey ?? null,
    ],
  );
}

async function roleIndexRows(driver: SqliteDriver) {
  return driver.read((tx) =>
    tx.query(
      `SELECT account_id, conversation_id, role, latest_at_ms, unread, starred
       FROM effective_role_conversations
       ORDER BY account_id, conversation_id, role`,
    ),
  );
}

async function insertTriggerBody(driver: SqliteDriver) {
  const [trigger] = await driver.read((tx) =>
    tx.query(
      "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'effective_conversations_after_insert'",
    ),
  );
  const sql = String(trigger?.sql);
  return sql.slice(sql.indexOf("BEGIN"));
}
