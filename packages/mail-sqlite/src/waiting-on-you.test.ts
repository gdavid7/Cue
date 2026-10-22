import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { WaitingOnYouQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SINCE = NOW - 14 * DAY;
const ME = "me@example.com";
const ANA = "Ana Lima <ana@example.com>";
const BEN = "Ben Ode <ben@example.com>";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readWaitingOnYou", () => {
  it("lists a conversation whose newest message is from someone you've written to", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({
        id: "ask",
        from: ANA,
        at: NOW - HOUR,
        subject: "Lunch?",
        read: false,
      }),
    ]);

    expect(await read(store)).toEqual([
      {
        accountId: "a",
        conversationId: "ask",
        messageId: "ask",
        from: ANA,
        subject: "Lunch?",
        preview: "",
        receivedAtMs: NOW - HOUR,
        unread: true,
        starred: false,
      },
    ]);
  });

  it("lists a stranger's reply in a conversation you started", async () => {
    const store = await setup();
    await write(store, [
      mail({
        id: "mine",
        conversation: "intro",
        from: ME,
        to: [BEN],
        at: NOW - 2 * DAY,
        roles: ["sent"],
      }),
      mail({ id: "reply", conversation: "intro", from: BEN, at: NOW - DAY }),
    ]);

    expect(await ids(store)).toEqual(["intro"]);
  });

  it("leaves out a conversation you've replied in since", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({ id: "ask", conversation: "t", from: ANA, at: NOW - 2 * HOUR }),
      mail({
        id: "answer",
        conversation: "t",
        from: ME,
        to: [ANA],
        at: NOW - HOUR,
        roles: ["sent"],
      }),
    ]);

    expect(await ids(store)).toEqual([]);
  });

  it("leaves out mail Gmail files under another tab", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({
        id: "promo",
        from: ANA,
        at: NOW - HOUR,
        categories: ["CATEGORY_PROMOTIONS"],
      }),
      mail({
        id: "primary",
        from: ANA,
        at: NOW - 2 * HOUR,
        categories: ["CATEGORY_PERSONAL"],
      }),
    ]);

    expect(await ids(store)).toEqual(["primary"]);
  });

  it("leaves out mail in Outlook's Other inbox", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({ id: "other", from: ANA, at: NOW - HOUR, section: "other" }),
      mail({
        id: "focused",
        from: ANA,
        at: NOW - 2 * HOUR,
        section: "focused",
      }),
    ]);

    expect(await ids(store)).toEqual(["focused"]);
  });

  it("leaves out mail filed under a label it was told to skip", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({ id: "filed", from: ANA, at: NOW - HOUR, labels: ["Label_news"] }),
      mail({
        id: "category",
        from: ANA,
        at: NOW - 2 * HOUR,
        categories: ["outlook-newsletter"],
      }),
      mail({ id: "kept", from: ANA, at: NOW - 3 * HOUR }),
    ]);

    expect(
      await ids(store, {
        excludedLabelIds: { a: ["Label_news", "outlook-newsletter"] },
      }),
    ).toEqual(["kept"]);
  });

  it("leaves out mail older than the window", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({ id: "old", from: ANA, at: SINCE - HOUR }),
    ]);

    expect(await ids(store)).toEqual([]);
  });

  it("leaves out mail from your own address left in the inbox", async () => {
    const store = await setup();
    await write(store, [
      mail({
        id: "sent",
        conversation: "t",
        from: ME,
        to: [ANA],
        at: NOW - 2 * HOUR,
        roles: ["sent"],
      }),
      // Outlook can file your own message in the inbox, not Sent.
      mail({
        id: "self",
        conversation: "t",
        from: `Me <${ME.toUpperCase()}>`,
        to: [ANA],
        at: NOW - HOUR,
      }),
    ]);

    expect(await ids(store)).toEqual([]);
  });

  it("leaves out someone you've never written to", async () => {
    const store = await setup();
    await write(store, [mail({ id: "cold", from: BEN, at: NOW - HOUR })]);

    expect(await ids(store)).toEqual([]);
  });

  it("leaves out archived conversations", async () => {
    const store = await setup();
    await write(store, [
      ...wroteToAna(),
      mail({ id: "done", from: ANA, at: NOW - HOUR, roles: [] }),
    ]);

    expect(await ids(store)).toEqual([]);
  });

  it("returns the newest first, up to the limit, across accounts", async () => {
    const store = await setup(["a", "b"]);
    await write(store, [
      ...wroteToAna(),
      mail({ id: "a1", from: ANA, at: NOW - 3 * HOUR }),
      mail({ id: "a2", from: ANA, at: NOW - HOUR }),
    ]);
    await write(
      store,
      [
        ...wroteToAna(),
        mail({ id: "b1", from: ANA, at: NOW - 2 * HOUR }),
        mail({ id: "b2", from: ANA, at: NOW - 4 * HOUR }),
      ],
      "b",
    );

    const rows = await read(store, { accountIds: ["a", "b"], limit: 3 });

    expect(rows.map((row) => [row.accountId, row.conversationId])).toEqual([
      ["a", "a2"],
      ["b", "b1"],
      ["a", "a1"],
    ]);
  });
});

// Mail you sent Ana long ago, so she's someone you write to.
function wroteToAna() {
  return [
    mail({
      id: "hello",
      from: ME,
      to: [ANA],
      at: NOW - 60 * DAY,
      roles: ["sent"],
    }),
  ];
}

async function setup(accountIds = ["a"]) {
  const store = await createSqliteMailStore(createNodeSqliteDriver());
  stores.push(store);
  for (const accountId of accountIds)
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g",
    });
  return store;
}

function read(store: MailStore, input: Partial<WaitingOnYouQuery> = {}) {
  return store.readWaitingOnYou({
    accountIds: ["a"],
    ownAddresses: [ME],
    receivedSinceMs: SINCE,
    limit: 5,
    ...input,
  });
}

async function ids(store: MailStore, input: Partial<WaitingOnYouQuery> = {}) {
  return (await read(store, input)).map((row) => row.conversationId);
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

function mail({
  id,
  conversation = id,
  from,
  to = [ME],
  at = NOW,
  subject = "",
  roles = ["inbox"],
  labels = [],
  categories = [],
  section = null,
  read = true,
}: {
  id: string;
  conversation?: string;
  from: string;
  to?: string[];
  at?: number;
  subject?: string;
  roles?: ("sent" | "inbox" | "trash")[];
  labels?: string[];
  categories?: string[];
  section?: "focused" | "other" | null;
  read?: boolean;
}): ProviderChange {
  return {
    kind: "message_patch",
    key: { accountId: "a", messageId: id },
    reference: {
      provider: "google",
      messageId: id,
      conversationId: conversation,
      version: "1",
    },
    fields: {
      from,
      to,
      cc: [],
      receivedAtMs: at,
      roles,
      subject,
      preview: "",
      read,
      starred: false,
      folderId: null,
      inboxSection: section,
      labelIds: labels,
      categoryIds: categories,
      hasAttachments: false,
    },
  };
}
