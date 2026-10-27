import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { LOCAL_MIGRATIONS } from "./local-migrations";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ACCOUNT = "a";
const T0 = 1_800_000_000_000;

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Reply-To", () => {
  it("returns each message's Reply-To with the conversation", async () => {
    const { store } = await open();
    await write(store, [
      patch("m1", {
        at: T0,
        replyTo: ["Billing <billing@pay.example>", "ops@pay.example"],
      }),
      patch("m2", { at: T0 + 1000 }),
    ]);

    expect(await replyTos(store)).toEqual({
      m1: ["Billing <billing@pay.example>", "ops@pay.example"],
      m2: undefined,
    });
  });

  it("keeps Reply-To through a later change that doesn't carry it", async () => {
    const { store } = await open();
    await write(store, [patch("m1", { replyTo: ["billing@pay.example"] })]);
    await write(store, [patch("m1", { read: true, version: "2" })]);

    expect(await replyTos(store)).toEqual({ m1: ["billing@pay.example"] });
  });

  it("adds the columns to a mailbox stored before them, reads old rows as having none, and fills them as messages are read again", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mail-sqlite-reply-to-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, "mail.sqlite");
    const before = await open(createNodeSqliteDriver(path));
    await write(before.store, [patch("m1")]);
    // The mailbox as a build before Reply-To left it.
    await before.driver.write(async (tx) => {
      await tx.exec("ALTER TABLE messages DROP COLUMN reply_to_json");
      await tx.exec("ALTER TABLE effective_messages DROP COLUMN reply_to_json");
      await tx.execute("DELETE FROM schema_migrations WHERE id = ?", [
        LOCAL_MIGRATIONS.replyTo.id,
      ]);
    });
    await before.store.close();
    cleanups.pop();

    const after = await open(createNodeSqliteDriver(path));

    expect(await replyTos(after.store)).toEqual({ m1: undefined });
    await write(after.store, [
      patch("m1", { version: "2", replyTo: ["billing@pay.example"] }),
    ]);
    expect(await replyTos(after.store)).toEqual({
      m1: ["billing@pay.example"],
    });
    expect(
      await after.driver.read((tx) =>
        tx.query("SELECT 1 FROM schema_migrations WHERE id = ?", [
          LOCAL_MIGRATIONS.replyTo.id,
        ]),
      ),
    ).toHaveLength(1);
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

async function replyTos(store: MailStore) {
  const { view } = await store.readConversation(
    { accountId: ACCOUNT, conversationId: "c1" },
    { after: null, pageSize: 25 },
  );
  return Object.fromEntries(
    view.messages.map((message) => [
      message.key.messageId,
      message.metadata.replyTo,
    ]),
  );
}

function patch(
  id: string,
  {
    at = T0,
    read = false,
    version = "1",
    replyTo,
  }: {
    at?: number;
    read?: boolean;
    version?: string;
    replyTo?: string[];
  } = {},
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: ACCOUNT, messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: "c1",
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
      ...(replyTo === undefined ? {} : { replyTo }),
    },
  };
}
