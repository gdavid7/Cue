import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ACCOUNT = "a";
const T0 = 1_800_000_000_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Message-ID headers", () => {
  it("keeps each message's Message-ID and names the latest one on its conversation", async () => {
    const { store } = await open();
    await write(store, [
      patch("m1", { at: T0, internetMessageId: "<first@mail>" }),
      patch("m2", { at: T0 + 1000, internetMessageId: "<second@mail>" }),
    ]);

    const [conversation] = await inbox(store);

    expect(conversation.latestMessageId).toBe("m2");
    expect(conversation.latestInternetMessageId).toBe("<second@mail>");
  });

  it("keeps the Message-ID through a later change that doesn't carry it", async () => {
    const { store } = await open();
    await write(store, [patch("m1", { internetMessageId: "<first@mail>" })]);
    await write(store, [patch("m1", { read: true, version: "2" })]);

    const [conversation] = await inbox(store);

    expect(conversation.latestInternetMessageId).toBe("<first@mail>");
  });

  it("adds the column to a mailbox stored before it, and fills it as messages are read again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mail-sqlite-msgid-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "mail.sqlite");
    const before = await open(createNodeSqliteDriver(path));
    await write(before.store, [
      patch("m1", { at: T0 }),
      patch("m2", { at: T0 + 1000, conversation: "c2" }),
    ]);
    // The mailbox as a build before Message-IDs left it.
    await before.driver.write(async (tx) => {
      await tx.exec("DROP INDEX messages_internet_message_id");
      await tx.exec("ALTER TABLE messages DROP COLUMN internet_message_id");
      await tx.exec("DELETE FROM schema_migrations WHERE id = 16");
    });
    await before.store.close();
    cleanups.pop();

    const after = await open(createNodeSqliteDriver(path));

    expect(await migrationRecorded(after.driver)).toBe(true);
    expect(await indexNames(after.driver)).toContain(
      "messages_internet_message_id",
    );
    // Nothing is refetched: stored mail stays and waits for its next read.
    expect(
      (await inbox(after.store)).map((c) => [
        c.latestMessageId,
        c.latestInternetMessageId,
      ]),
    ).toEqual([
      ["m2", undefined],
      ["m1", undefined],
    ]);

    await write(after.store, [
      patch("m1", { at: T0, internetMessageId: "<first@mail>" }),
    ]);

    expect(
      (await inbox(after.store)).map((c) => [
        c.latestMessageId,
        c.latestInternetMessageId,
      ]),
    ).toEqual([
      ["m2", undefined],
      ["m1", "<first@mail>"],
    ]);
  });

  it("migrates once", async () => {
    const { driver, store } = await open();
    await write(store, [patch("m1", { internetMessageId: "<first@mail>" })]);

    await createSqliteMailStore(driver);

    expect(
      await driver.read((tx) =>
        tx.query("SELECT internet_message_id FROM messages"),
      ),
    ).toEqual([{ internet_message_id: "<first@mail>" }]);
  });
});

async function open(driver: SqliteDriver = createNodeSqliteDriver()) {
  const store = await createSqliteMailStore(driver);
  cleanups.push(() => store.close());
  await store.ensureAccount({
    accountId: ACCOUNT,
    provider: "google",
    generation: "g",
  });
  return { driver, store };
}

async function write(store: MailStore, changes: ProviderChange[]) {
  expect(
    await store.applyHydration({
      session: { accountId: ACCOUNT, generation: "g" },
      requestId: "test",
      changes,
      bodies: [],
    }),
  ).toMatchObject({ status: "committed" });
}

async function inbox(store: MailStore) {
  const { view } = await store.readMailboxView({
    accountIds: [ACCOUNT],
    predicate: { kind: "mailbox", mailbox: "inbox" },
    order: "newest_first",
    pageSize: 25,
    after: null,
  });
  return view.conversations;
}

async function migrationRecorded(driver: SqliteDriver) {
  const rows = await driver.read((tx) =>
    tx.query("SELECT 1 FROM schema_migrations WHERE id = 16"),
  );
  return rows.length > 0;
}

async function indexNames(driver: SqliteDriver) {
  const rows = await driver.read((tx) =>
    tx.query(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'",
    ),
  );
  return rows.map((row) => String(row.name));
}

function patch(
  id: string,
  {
    conversation = "c1",
    at = T0,
    read = false,
    version = "1",
    internetMessageId,
  }: {
    conversation?: string;
    at?: number;
    read?: boolean;
    version?: string;
    internetMessageId?: string;
  } = {},
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: ACCOUNT, messageId: id },
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
      roles: ["inbox"],
      hasAttachments: false,
      ...(internetMessageId ? { internetMessageId } : {}),
    },
  };
}
