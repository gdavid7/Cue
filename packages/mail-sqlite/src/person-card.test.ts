import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { PersonCardQuery } from "@inboxzero/mail-core/queries";
import type {
  BodyObservation,
  ProviderChange,
} from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { measureReplyLag } from "./person-card";
import { createSqliteMailStore } from "./store";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const ME = "me@example.com";
const ANA = "Ana Lima <ana@example.com>";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("readPersonCard", () => {
  it("lists their conversations newest first, from the asked accounts only", async () => {
    const { store } = await setup(["a", "b", "c"]);
    await write(store, [
      mail({
        id: "a1",
        conversation: "old",
        from: ANA,
        at: T0,
        subject: "Old",
      }),
      mail({ id: "a2", conversation: "new", from: ANA, at: T0 + 5 * HOUR }),
      mail({
        id: "a3",
        conversation: "new",
        from: ME,
        to: [ANA],
        at: T0 + 6 * HOUR,
        subject: "Re: New",
        roles: ["sent"],
      }),
      mail({
        id: "a4",
        conversation: "trashed",
        from: ANA,
        at: T0 + 9 * HOUR,
        roles: ["trash"],
      }),
      mail({ id: "x1", conversation: "someone", from: "x@example.com" }),
    ]);
    await write(
      store,
      [mail({ id: "b1", conversation: "b", from: ANA, at: T0 + 2 * HOUR })],
      "b",
    );
    await write(
      store,
      [mail({ id: "c1", conversation: "c", from: ANA, at: T0 + 8 * HOUR })],
      "c",
    );

    const card = await read(store, { accountIds: ["a", "b"] });

    expect(card.email).toBe("ana@example.com");
    expect(card.name).toBe("Ana Lima");
    expect(
      card.conversations.map((c) => [c.accountId, c.conversationId, c.subject]),
    ).toEqual([
      ["a", "new", "Re: New"],
      ["b", "b", ""],
      ["a", "old", "Old"],
    ]);
  });

  it("matches the address whatever its case or display name", async () => {
    const { store } = await setup();
    await write(store, [mail({ id: "1", from: "ANA <Ana@Example.com>" })]);
    const card = await read(store, { email: " ANA@example.com " });
    expect(card.conversations).toHaveLength(1);
  });

  it("measures how long each side takes to answer from the conversations both wrote in", async () => {
    const { store } = await setup();
    const thread = (n: number, theirHours: number, myHours: number) => [
      mail({
        id: `${n}-me`,
        conversation: `t${n}`,
        from: ME,
        to: [ANA],
        at: T0 + n * 100 * HOUR,
        roles: ["sent"],
      }),
      mail({
        id: `${n}-them`,
        conversation: `t${n}`,
        from: ANA,
        at: T0 + (n * 100 + theirHours) * HOUR,
      }),
      mail({
        id: `${n}-me2`,
        conversation: `t${n}`,
        from: ME,
        to: [ANA],
        at: T0 + (n * 100 + theirHours + myHours) * HOUR,
        roles: ["sent"],
      }),
    ];
    await write(store, [
      ...thread(1, 2, 1),
      ...thread(2, 4, 3),
      ...thread(3, 30, 5),
      // Only they wrote here, so it says nothing about either side.
      mail({ id: "solo", conversation: "solo", from: ANA, at: T0 }),
    ]);

    const card = await read(store);

    expect(card.replyLag).toEqual({
      theirs: { medianMs: 4 * HOUR, exchanges: 3 },
      yours: { medianMs: 3 * HOUR, exchanges: 3 },
    });
  });

  it("lists the files on their messages, without inline images or repeats", async () => {
    const { store } = await setup();
    await write(
      store,
      [
        mail({ id: "f1", from: ANA, at: T0, attachments: true }),
        mail({ id: "f2", from: ANA, at: T0 + HOUR, attachments: true }),
        // Sent to them: not a file they shared.
        mail({
          id: "mine",
          from: ME,
          to: [ANA],
          at: T0 + 2 * HOUR,
          roles: ["sent"],
          attachments: true,
        }),
        // Its body isn't here yet, so its files aren't known.
        mail({ id: "unread", from: ANA, at: T0 + 3 * HOUR, attachments: true }),
      ],
      "a",
      [
        body("f1", [file("plan.pdf", 10), file("logo.png", 2, true)]),
        body("f2", [file("plan.pdf", 10), file("budget.xlsx", 20)]),
        body("mine", [file("mine.pdf", 5)]),
      ],
    );

    const card = await read(store);

    expect(card.files.map((f) => [f.messageId, f.attachment.filename])).toEqual(
      [
        ["f2", "plan.pdf"],
        ["f2", "budget.xlsx"],
      ],
    );
  });

  it("lists open asks from Cue's reply tracking labels", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "1", conversation: "ask", from: ANA, labels: ["L_TO_REPLY"] }),
      mail({
        id: "2",
        conversation: "wait",
        from: ME,
        to: [ANA],
        roles: ["sent"],
        labels: ["L_AWAITING"],
      }),
      mail({ id: "3", conversation: "done", from: ANA }),
      // Someone else's conversation waiting on you isn't theirs.
      mail({
        id: "4",
        conversation: "other",
        from: "x@example.com",
        labels: ["L_TO_REPLY"],
      }),
    ]);

    const card = await read(store, {
      replyTracking: [
        {
          accountId: "a",
          toReplyLabelId: "L_TO_REPLY",
          awaitingReplyLabelId: "L_AWAITING",
        },
      ],
    });

    expect(card.awaitingYou.map((c) => c.conversationId)).toEqual(["ask"]);
    expect(card.awaitingThem.map((c) => c.conversationId)).toEqual(["wait"]);
  });

  it("names other addresses only when they carry exactly the same full name", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "1", from: ANA }),
      mail({ id: "2", from: "Ana Lima <ana@work.example>" }),
      mail({ id: "3", from: "ana lima <lowercase@example.com>" }),
      mail({ id: "4", from: "Ana Lima Costa <costa@example.com>" }),
      mail({ id: "5", from: "Ana Lima <me@example.com>" }),
      mail({ id: "6", from: "Bo <bo@example.com>" }),
      mail({ id: "7", from: "Bo <bo@other.example>" }),
    ]);

    expect((await read(store)).otherAddresses).toEqual(["ana@work.example"]);
    // A lone first name is too common to say it's the same person.
    expect(
      (await read(store, { email: "bo@example.com" })).otherAddresses,
    ).toEqual([]);
  });

  it("says older mail is still syncing until coverage and the contact index are complete", async () => {
    const { store, driver } = await setup();
    await write(store, [mail({ id: "1", from: ANA })]);
    expect((await read(store)).history).toEqual({
      syncing: true,
      sinceMs: null,
    });

    while ((await store.indexContactBacklog()).remaining) {
      /* drain */
    }
    await driver.write((tx) =>
      tx.execute(
        `INSERT INTO coverage(account_id, scope_id, metadata, content, indexed_content, window_start_ms)
         VALUES ('a', 'primary', 'complete', 'partial', 'partial', ?)`,
        [T0],
      ),
    );
    expect((await read(store)).history).toEqual({
      syncing: false,
      sinceMs: T0,
    });
  });

  it("flags a no-reply sender, whose mail the contact index leaves out", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "1", from: "Shop <no-reply@shop.example>" }),
    ]);
    const card = await read(store, { email: "no-reply@shop.example" });
    expect(card).toMatchObject({ automated: true, conversations: [] });
  });

  it("returns an empty card for someone the store has never seen", async () => {
    const { store } = await setup();
    const card = await read(store, { email: "nobody@example.com" });
    expect(card).toMatchObject({
      automated: false,
      name: null,
      conversations: [],
      files: [],
      replyLag: { theirs: null, yours: null },
      awaitingYou: [],
      awaitingThem: [],
    });
  });
});

describe("measureReplyLag", () => {
  const msg = (conversation: string, hours: number, from: "you" | "them") => ({
    conversation,
    atMs: hours * HOUR,
    from,
  });

  it("needs three replies on a side before it says anything", () => {
    expect(
      measureReplyLag([
        msg("a", 0, "you"),
        msg("a", 1, "them"),
        msg("b", 0, "you"),
        msg("b", 2, "them"),
      ]),
    ).toEqual({ theirs: null, yours: null });
  });

  it("times a reply from the first message it answers, not the nudge", () => {
    const lag = measureReplyLag([
      msg("a", 0, "you"),
      msg("a", 20, "you"),
      msg("a", 24, "them"),
      msg("b", 0, "you"),
      msg("b", 2, "them"),
      msg("c", 0, "you"),
      msg("c", 10, "them"),
    ]);
    expect(lag.theirs).toEqual({ medianMs: 10 * HOUR, exchanges: 3 });
  });

  it("averages the middle two of an even count, and orders messages by time", () => {
    const lag = measureReplyLag([
      msg("a", 1, "you"),
      msg("a", 0, "them"),
      msg("a", 5, "them"),
      msg("a", 8, "you"),
      msg("b", 0, "them"),
      msg("b", 2, "you"),
      msg("c", 0, "them"),
      msg("c", 10, "you"),
    ]);
    expect(lag.yours).toEqual({ medianMs: 2.5 * HOUR, exchanges: 4 });
    expect(lag.theirs).toBeNull();
  });

  it("keeps conversations apart", () => {
    // Read as one thread these would be three quick replies.
    const lag = measureReplyLag([
      msg("a", 0, "you"),
      msg("b", 1, "them"),
      msg("c", 2, "you"),
      msg("d", 3, "them"),
    ]);
    expect(lag).toEqual({ theirs: null, yours: null });
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

function read(store: MailStore, input: Partial<PersonCardQuery> = {}) {
  return store.readPersonCard({
    accountIds: ["a"],
    email: "ana@example.com",
    ownAddresses: [ME],
    replyTracking: [],
    ...input,
  });
}

async function write(
  store: MailStore,
  changes: ProviderChange[],
  accountId = "a",
  bodies: BodyObservation[] = [],
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
      bodies: bodies.map((observation) => ({
        ...observation,
        key: { ...observation.key, accountId },
      })),
    }),
  ).toMatchObject({ status: "committed" });
}

function mail({
  id,
  conversation = id,
  from,
  to = [ME],
  at = T0,
  subject = "",
  roles = ["inbox"],
  labels = [],
  attachments = false,
}: {
  id: string;
  conversation?: string;
  from: string;
  to?: string[];
  at?: number;
  subject?: string;
  roles?: ("sent" | "inbox" | "trash")[];
  labels?: string[];
  attachments?: boolean;
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
      read: true,
      starred: false,
      folderId: null,
      labelIds: labels,
      categoryIds: [],
      hasAttachments: attachments,
    },
  };
}

function body(
  messageId: string,
  attachments: BodyObservation["attachments"],
): BodyObservation {
  return {
    key: { accountId: "a", messageId },
    version: "1",
    html: null,
    text: "body",
    attachments,
  };
}

function file(filename: string, size: number, inline = false) {
  return {
    attachmentId: `att-${filename}`,
    filename,
    mimeType: "application/octet-stream",
    size,
    inline,
  };
}
