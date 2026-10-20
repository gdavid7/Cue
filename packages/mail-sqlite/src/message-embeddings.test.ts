import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";
import { migrateMailbox } from "./migrations";

const MODEL = "test-model";
const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const CAP = { model: MODEL, sinceMs: NOW - 30 * DAY_MS, maxMessages: 100 };

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("message embeddings", () => {
  it("adds the table once, to a mailbox that predates it", async () => {
    const driver = createNodeSqliteDriver();
    await driver.write((tx) => migrateMailbox(tx, "epoch"));
    await driver.write((tx) => tx.exec("DROP TABLE message_embeddings"));
    await driver.write((tx) =>
      tx.execute("DELETE FROM schema_migrations WHERE id = 12"),
    );
    await driver.write((tx) => migrateMailbox(tx, "epoch"));
    await driver.write((tx) => migrateMailbox(tx, "epoch"));
    const tables = await driver.read((tx) =>
      tx.query(
        "SELECT name FROM sqlite_master WHERE name = 'message_embeddings'",
      ),
    );
    expect(tables).toHaveLength(1);
    await driver.close();
  });

  it("offers the newest mail within the cap, without spam, trash or drafts", async () => {
    const store = await setup();
    await write(store, [
      message("new", { receivedAtMs: NOW }),
      message("older", { receivedAtMs: NOW - DAY_MS }),
      message("too-old", { receivedAtMs: NOW - 60 * DAY_MS }),
      message("spam", {
        receivedAtMs: NOW,
        labelIds: ["SPAM"],
        roles: ["spam"],
      }),
      message("trash", {
        receivedAtMs: NOW,
        labelIds: ["TRASH"],
        roles: ["trash"],
      }),
    ]);
    const backlog = await store.readEmbeddingBacklog({ ...CAP, limit: 10 });
    expect(backlog.map((source) => source.key.messageId)).toEqual([
      "new",
      "older",
    ]);
    expect(backlog[0]).toMatchObject({
      subject: "Subject new",
      body: "Preview new",
      fromBody: false,
    });
  });

  it("caps the mail it covers at the newest maxMessages", async () => {
    const store = await setup();
    await write(
      store,
      Array.from({ length: 5 }, (_, index) =>
        message(`m${index}`, { receivedAtMs: NOW - index * 1000 }),
      ),
    );
    const backlog = await store.readEmbeddingBacklog({
      ...CAP,
      maxMessages: 3,
      limit: 10,
    });
    expect(backlog.map((source) => source.key.messageId)).toEqual([
      "m0",
      "m1",
      "m2",
    ]);
  });

  it("reads the stored body, and embeds a preview-only message again once its body arrives", async () => {
    const store = await setup();
    await write(store, [message("m", { receivedAtMs: NOW })]);
    const [first] = await store.readEmbeddingBacklog({ ...CAP, limit: 10 });
    await store.writeMessageEmbeddings({
      model: MODEL,
      embeddings: [{ ...first, vector: vector([1, 0]) }],
    });
    expect(await store.readEmbeddingBacklog({ ...CAP, limit: 10 })).toEqual([]);

    await write(store, [], [{ id: "m", text: "  The kitchen\n invoice  " }]);
    const [again] = await store.readEmbeddingBacklog({ ...CAP, limit: 10 });
    expect(again).toMatchObject({
      body: "The kitchen invoice",
      fromBody: true,
    });
    await store.writeMessageEmbeddings({
      model: MODEL,
      embeddings: [{ ...again, vector: vector([1, 0]) }],
    });
    expect(await store.readEmbeddingBacklog({ ...CAP, limit: 10 })).toEqual([]);
    // Another model's vector is not this one's.
    expect(
      await store.readEmbeddingBacklog({
        ...CAP,
        model: "other-model",
        limit: 10,
      }),
    ).toHaveLength(1);
  });

  it("finds the nearest conversations, one match each, above the floor", async () => {
    const store = await setup();
    await write(store, [
      message("a1", { conversationId: "a" }),
      message("a2", { conversationId: "a" }),
      message("b", { conversationId: "b" }),
      message("c", { conversationId: "c" }),
    ]);
    await embed(store, {
      a1: [1, 0],
      a2: [0.8, 0.6],
      b: [0.6, 0.8],
      c: [-1, 0],
    });
    const matches = await store.readSemanticMatches({
      accountId: "a",
      model: MODEL,
      vector: vector([1, 0]),
      limit: 10,
      minSimilarity: 0.5,
    });
    expect(
      matches.map(({ messageId, conversationId }) => ({
        messageId,
        conversationId,
      })),
    ).toEqual([
      { messageId: "a1", conversationId: "a" },
      { messageId: "b", conversationId: "b" },
    ]);
    expect(matches[0].similarity).toBeCloseTo(1, 1);
    expect(matches[1].similarity).toBeCloseTo(0.6, 1);
    expect(
      await store.countMessageEmbeddings({ accountId: "a", model: MODEL }),
    ).toBe(4);
  });

  it("prunes vectors outside the cap, of another model, or of mail since trashed", async () => {
    const store = await setup();
    await write(store, [
      message("keep", { receivedAtMs: NOW }),
      message("aged", { receivedAtMs: NOW - 60 * DAY_MS }),
      message("trashed", { receivedAtMs: NOW }),
    ]);
    await embed(store, { keep: [1, 0], trashed: [1, 0] });
    await embed(store, { aged: [1, 0] }, NOW - 60 * DAY_MS);
    await store.writeMessageEmbeddings({
      model: "old-model",
      embeddings: [
        {
          key: { accountId: "a", messageId: "keep" },
          receivedAtMs: NOW,
          fromBody: false,
          vector: vector([1, 0]),
        },
      ],
    });
    await write(store, [
      message("trashed", {
        receivedAtMs: NOW,
        labelIds: ["TRASH"],
        roles: ["trash"],
      }),
    ]);
    // "keep" now holds the old model's vector, which is pruned too.
    expect(await store.pruneMessageEmbeddings(CAP)).toBe(3);
    expect(
      await store.countMessageEmbeddings({ accountId: "a", model: MODEL }),
    ).toBe(0);
  });

  it("forgets an account's vectors with the account", async () => {
    const store = await setup();
    await write(store, [message("m")]);
    await embed(store, { m: [1, 0] });
    await store.purgeAccount("a");
    expect(
      await store.countMessageEmbeddings({ accountId: "a", model: MODEL }),
    ).toBe(0);
  });
});

async function setup() {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  stores.push(store);
  await store.ensureAccount({
    accountId: "a",
    provider: "google",
    generation: "g",
  });
  return store;
}

async function write(
  store: MailStore,
  changes: ProviderChange[],
  bodies: { id: string; text: string }[] = [],
) {
  expect(
    await store.applyHydration({
      session: { accountId: "a", generation: "g" },
      requestId: "test",
      changes,
      bodies: bodies.map(({ id, text }) => ({
        key: { accountId: "a", messageId: id },
        version: "1",
        text,
        html: null,
      })),
    }),
  ).toMatchObject({ status: "committed" });
}

async function embed(
  store: MailStore,
  vectors: Record<string, number[]>,
  receivedAtMs = NOW,
) {
  await store.writeMessageEmbeddings({
    model: MODEL,
    embeddings: Object.entries(vectors).map(([messageId, values]) => ({
      key: { accountId: "a", messageId },
      receivedAtMs,
      fromBody: false,
      vector: vector(values),
    })),
  });
}

function vector(values: number[]) {
  return Int8Array.from(values.map((value) => Math.round(value * 127)));
}

function message(
  id: string,
  {
    conversationId = id,
    receivedAtMs = NOW,
    labelIds = ["INBOX"],
    roles = ["inbox"],
  }: {
    conversationId?: string;
    receivedAtMs?: number;
    labelIds?: string[];
    roles?: ("inbox" | "spam" | "trash")[];
  } = {},
): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId,
      version: "1",
    },
    fields: {
      from: "Sender <sender@example.com>",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs,
      roles,
      subject: `Subject ${id}`,
      preview: `Preview ${id}`,
      read: true,
      starred: false,
      folderId: null,
      labelIds,
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
