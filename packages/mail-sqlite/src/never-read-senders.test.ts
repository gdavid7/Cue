import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { NeverReadSendersQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { NEVER_READ_SENDERS_SQL } from "./never-read-senders";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SINCE = NOW - 30 * DAY;
const ME = "me@example.com";
const DEALS = "Daily Deals <deals@shop.example>";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readNeverReadSenders", () => {
  it("lists a sender with four unread inbox messages, not one with three", async () => {
    const { store } = await setup();
    await write(store, [
      ...series("deals", DEALS, 4),
      ...series("news", "news@paper.example", 3),
    ]);

    expect(await read(store)).toEqual([
      {
        accountId: "a",
        email: "deals@shop.example",
        name: "Daily Deals",
        count: 4,
        lastReceivedAtMs: NOW - DAY,
      },
    ]);
  });

  it("leaves out a sender once any of their inbox messages is read", async () => {
    const { store } = await setup();
    await write(store, [
      ...series("deals", DEALS, 6),
      mail({ id: "deals-read", from: DEALS, at: NOW - 2 * HOUR, read: true }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("counts only mail received in the window", async () => {
    const { store } = await setup();
    await write(store, [
      // Three in the window and two before it: too few to list.
      ...series("deals", DEALS, 3),
      mail({ id: "deals-old-1", from: DEALS, at: SINCE - DAY }),
      mail({ id: "deals-old-2", from: DEALS, at: SINCE - 2 * DAY }),
      // Four in the window; one read before it says nothing about now.
      ...series("news", "news@paper.example", 4),
      mail({
        id: "news-old-read",
        from: "news@paper.example",
        at: SINCE - DAY,
        read: true,
      }),
    ]);

    expect((await read(store)).map((sender) => sender.email)).toEqual([
      "news@paper.example",
    ]);
  });

  it("counts inbox mail only", async () => {
    const { store } = await setup();
    await write(store, [
      ...series("deals", DEALS, 3),
      mail({ id: "deals-archived", from: DEALS, roles: [] }),
      mail({ id: "deals-trash", from: DEALS, roles: ["trash"] }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("never lists the user's own addresses, whatever their case or name", async () => {
    const { store } = await setup();
    await write(store, [
      ...series("me", "Me Myself <ME@Example.com>", 5),
      ...series("alias", "me.alias@example.com", 5),
    ]);

    expect(
      await read(store, { ownAddresses: [ME, " Me.Alias@example.com "] }),
    ).toEqual([]);
  });

  it("groups one address under any case or display name, named as its newest message is", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "1", from: "Deals <DEALS@shop.example>", at: NOW - 5 * DAY }),
      mail({ id: "2", from: "deals@shop.example", at: NOW - 4 * DAY }),
      mail({ id: "3", from: "Shop Deals <deals@shop.example>", at: NOW - DAY }),
      mail({ id: "4", from: "deals@shop.example", at: NOW - 3 * DAY }),
    ]);

    expect(await read(store)).toEqual([
      {
        accountId: "a",
        email: "deals@shop.example",
        name: "Shop Deals",
        count: 4,
        lastReceivedAtMs: NOW - DAY,
      },
    ]);
  });

  it("lists the five with the most messages, then the newest", async () => {
    const { store } = await setup();
    await write(store, [
      ...series("s1", "s1@x.example", 4, NOW - 9 * DAY),
      ...series("s2", "s2@x.example", 9),
      ...series("s3", "s3@x.example", 4, NOW - 2 * DAY),
      ...series("s4", "s4@x.example", 7),
      ...series("s5", "s5@x.example", 5),
      ...series("s6", "s6@x.example", 4, NOW - 5 * DAY),
    ]);

    expect((await read(store)).map((sender) => sender.email)).toEqual([
      "s2@x.example",
      "s4@x.example",
      "s5@x.example",
      "s3@x.example",
      "s6@x.example",
    ]);
  });

  it("reads each asked account on its own", async () => {
    const { store } = await setup(["a", "b", "c"]);
    await write(store, series("a-deals", DEALS, 4), "a");
    // Three in each of two accounts is not four in either.
    await write(store, series("a-news", "news@paper.example", 3), "a");
    await write(store, series("b-news", "news@paper.example", 3), "b");
    // A read message in one account doesn't hide the sender in another.
    await write(
      store,
      [
        ...series("b-deals", DEALS, 5),
        mail({ id: "b-deals-read", from: DEALS, read: true }),
      ],
      "b",
    );
    await write(store, series("c-deals", DEALS, 8), "c");

    expect(
      (await read(store, { accountIds: ["a", "b"] })).map((sender) => [
        sender.accountId,
        sender.email,
        sender.count,
      ]),
    ).toEqual([["a", "deals@shop.example", 4]]);
    expect(
      (await read(store, { accountIds: ["a", "c"] })).map((sender) => [
        sender.accountId,
        sender.count,
      ]),
    ).toEqual([
      ["c", 8],
      ["a", 4],
    ]);
  });

  it("reads the window through the inbox index", async () => {
    const { driver } = await setup();
    const plan = await driver.read((tx) =>
      tx.query(`EXPLAIN QUERY PLAN ${NEVER_READ_SENDERS_SQL}`, ["a", SINCE]),
    );
    const details = plan.map((row) => String(row.detail));

    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH effective_messages USING INDEX effective_inbox_order \(account_id=\? AND in_inbox=\? AND received_at_ms>\?\)/,
      ),
    );
    expect(details.some((detail) => detail.startsWith("SCAN"))).toBe(false);
  });
});

async function setup(accountIds = ["a"]) {
  const driver: SqliteDriver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  stores.push(store);
  for (const accountId of accountIds)
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g",
    });
  return { store, driver };
}

function read(store: MailStore, input: Partial<NeverReadSendersQuery> = {}) {
  return store.readNeverReadSenders({
    accountIds: ["a"],
    ownAddresses: [ME],
    receivedSinceMs: SINCE,
    ...input,
  });
}

async function write(
  store: MailStore,
  changes: ProviderChange[],
  accountId = "a",
) {
  expect(
    await store.applyHydration({
      session: { accountId, generation: "g" },
      requestId: "test",
      changes: changes.map((change) =>
        change.kind === "message_patch"
          ? { ...change, key: { ...change.key, accountId } }
          : change,
      ),
      bodies: [],
    }),
  ).toMatchObject({ status: "committed" });
}

/** `count` unread inbox messages from one sender, a day apart, newest at `newestAt`. */
function series(
  prefix: string,
  from: string,
  count: number,
  newestAt = NOW - DAY,
) {
  return Array.from({ length: count }, (_, index) =>
    mail({ id: `${prefix}-${index}`, from, at: newestAt - index * DAY }),
  );
}

function mail({
  id,
  from,
  at = NOW - DAY,
  read = false,
  roles = ["inbox"],
}: {
  id: string;
  from: string;
  at?: number;
  read?: boolean;
  roles?: ("inbox" | "trash")[];
}): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: id,
      version: "1",
    },
    fields: {
      from,
      to: [ME],
      cc: [],
      receivedAtMs: at,
      roles,
      subject: "",
      preview: "",
      read,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
