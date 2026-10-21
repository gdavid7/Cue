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

  it("names other addresses you have sent to under exactly the same full name", async () => {
    const { store } = await setup();
    // Each alias is written to in two conversations.
    const sent = (id: string, to: string, at = T0) => [
      mail({ id, from: ME, to: [to], at, roles: ["sent"] }),
      mail({ id: `${id}b`, from: ME, to: [to], at, roles: ["sent"] }),
    ];
    await write(store, [
      ...sent("1", ANA),
      ...sent("2", "Ana Lima <ana@work.example>", T0 + HOUR),
      ...sent("3", "Ana Lima <ana@home.example>", T0 + 2 * HOUR),
      ...sent("4", "ana lima <lowercase@example.com>"),
      ...sent("5", "Ana Lima Costa <costa@example.com>"),
      ...sent("6", "Bo <bo@example.com>"),
      ...sent("7", "Bo <bo@other.example>"),
      // Anyone can claim her name on mail they send you.
      mail({ id: "8", from: "Ana Lima <ana.payroll@evil.example>" }),
    ]);

    expect((await read(store)).otherAddresses).toEqual([
      "ana@home.example",
      "ana@work.example",
    ]);
    // A lone first name is too common to say it's the same person.
    expect(
      (await read(store, { email: "bo@example.com" })).otherAddresses,
    ).toEqual([]);
  });

  it("needs her name on your mail to an address in two conversations to call it hers", async () => {
    const { store } = await setup();
    const SPOOF = "Ana Lima <ana.payroll@evil.example>";
    await write(store, [
      mail({
        id: "1",
        conversation: "c1",
        from: ME,
        to: [ANA],
        roles: ["sent"],
      }),
      mail({
        id: "2",
        conversation: "c2",
        from: ME,
        to: [ANA],
        roles: ["sent"],
      }),
      // Replying to a stranger copies the name they chose back to them.
      mail({ id: "3", conversation: "spoof", from: SPOOF, at: T0 + HOUR }),
      mail({
        id: "4",
        conversation: "spoof",
        from: ME,
        to: [SPOOF],
        at: T0 + 2 * HOUR,
        roles: ["sent"],
      }),
      mail({
        id: "5",
        conversation: "spoof",
        from: ME,
        to: [SPOOF],
        at: T0 + 3 * HOUR,
        roles: ["sent"],
      }),
    ]);
    expect((await read(store)).otherAddresses).toEqual([]);
    // Nor does the stranger's own card vouch for the address they borrowed
    // the name from.
    expect(
      (await read(store, { email: "ana.payroll@evil.example" })).otherAddresses,
    ).toEqual([]);

    await write(store, [
      mail({
        id: "6",
        conversation: "w1",
        from: ME,
        to: ["Ana Lima <ana@work.example>"],
        roles: ["sent"],
      }),
      mail({
        id: "7",
        conversation: "w2",
        from: ME,
        to: ["Ana Lima <ana@work.example>"],
        roles: ["sent"],
      }),
    ]);
    expect((await read(store)).otherAddresses).toEqual(["ana@work.example"]);
  });

  it("counts a sent message that is in two of your accounts as one conversation", async () => {
    const { store } = await setup(["a", "b"]);
    const WORK = "Ana Lima <ana@work.example>";
    await write(store, [
      mail({
        id: "1",
        conversation: "c1",
        from: ME,
        to: [ANA],
        roles: ["sent"],
      }),
      mail({
        id: "2",
        conversation: "c2",
        from: ME,
        to: [ANA],
        roles: ["sent"],
      }),
      mail({
        id: "3",
        conversation: "w",
        from: ME,
        to: [WORK],
        roles: ["sent"],
      }),
    ]);
    await write(
      store,
      [
        mail({
          id: "3",
          conversation: "w",
          from: ME,
          to: [WORK],
          roles: ["sent"],
        }),
      ],
      "b",
    );

    const card = await read(store, { accountIds: ["a", "b"] });

    expect(card.otherAddresses).toEqual([]);
  });

  it("takes their name only from mail you sent them", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "1", from: "Totally Ana <ana@example.com>" }),
      mail({ id: "2", from: "Totally Ana <ana@example.com>" }),
    ]);
    expect((await read(store)).name).toBeNull();

    await write(store, [
      mail({ id: "3", from: ME, to: [ANA], roles: ["sent"] }),
    ]);
    expect((await read(store)).name).toBe("Ana Lima");
  });

  it("shows a message that reached two of your accounts once", async () => {
    const { store } = await setup(["a", "b"]);
    const exchange = (account: string, offset: number) =>
      [
        mail({
          id: `${account}-1`,
          conversation: "t",
          from: ANA,
          at: T0 + offset,
          subject: "Plan",
        }),
        mail({
          id: `${account}-2`,
          conversation: "t",
          from: ME,
          to: [ANA],
          at: T0 + HOUR + offset,
          subject: "Re: Plan",
          roles: ["sent"],
        }),
      ] satisfies ProviderChange[];
    await write(store, exchange("a", 0), "a");
    await write(store, exchange("b", 30_000), "b");

    const card = await read(store, { accountIds: ["a", "b"] });

    expect(card.conversations).toHaveLength(1);
  });

  it("keeps one copy of a message to two accounts when only one account has the reply", async () => {
    const { store } = await setup(["a", "b"]);
    // Ana writes to both accounts; you answer from whichever account she
    // wrote to, two hours later, so one conversation has more in it.
    for (const [n, replyFrom] of [
      [1, "a"],
      [2, "b"],
      [3, "a"],
    ] as const) {
      const at = T0 + n * 100 * HOUR;
      for (const account of ["a", "b"]) {
        const changes = [
          mail({
            id: `${account}-${n}`,
            conversation: `${account}-t${n}`,
            from: ANA,
            to: [ME, "me@b.example"],
            at: at + (account === "b" ? 20_000 : 0),
            subject: "Plan",
            labels: account === "a" && n === 2 ? ["L_TO_REPLY"] : [],
          }),
        ];
        if (account === replyFrom)
          changes.push(
            mail({
              id: `${account}-${n}-re`,
              conversation: `${account}-t${n}`,
              from: ME,
              to: [ANA],
              at: at + 2 * HOUR,
              subject: "Re: Plan",
              roles: ["sent"],
            }),
          );
        await write(store, changes, account);
      }
    }

    const card = await read(store, {
      accountIds: ["a", "b"],
      replyTracking: [
        {
          accountId: "a",
          toReplyLabelId: "L_TO_REPLY",
          awaitingReplyLabelId: null,
        },
      ],
    });

    expect(card.conversations.map((c) => c.conversationId)).toEqual([
      "a-t3",
      "b-t2",
      "a-t1",
    ]);
    expect(card.replyLag.yours).toEqual({ medianMs: 2 * HOUR, exchanges: 3 });
    // Asked in the copy that's hidden, shown on the one that stays.
    expect(card.awaitingYou.map((c) => c.conversationId)).toEqual(["b-t2"]);
  });

  it("shows separate conversations that only share a subject", async () => {
    const { store } = await setup(["a", "b"]);
    await write(
      store,
      [mail({ id: "a1", from: ANA, at: T0, subject: "Weekly" })],
      "a",
    );
    await write(
      store,
      [
        // A new message a few minutes later, not a copy of the first.
        mail({ id: "b1", from: ANA, at: T0 + 3 * 60_000, subject: "Weekly" }),
        // Same moment, but to different people.
        mail({
          id: "b2",
          from: ANA,
          to: [ME, "bo@example.com"],
          at: T0,
          subject: "Weekly",
        }),
      ],
      "b",
    );

    const card = await read(store, { accountIds: ["a", "b"] });

    expect(card.conversations.map((c) => c.conversationId).sort()).toEqual([
      "a1",
      "b1",
      "b2",
    ]);
  });

  it("counts a shared message once when each account's conversation has its own replies", async () => {
    const { store } = await setup(["a", "b"]);
    for (const n of [1, 2, 3]) {
      const at = T0 + n * 100 * HOUR;
      await write(
        store,
        [
          mail({ id: `a-${n}`, conversation: `a-t${n}`, from: ANA, at }),
          mail({
            id: `a-${n}-re`,
            conversation: `a-t${n}`,
            from: ME,
            to: [ANA],
            at: at + HOUR,
            roles: ["sent"],
          }),
        ],
        "a",
      );
      await write(
        store,
        [
          mail({
            id: `b-${n}`,
            conversation: `b-t${n}`,
            from: ANA,
            at,
          }),
          // Her answer reached only this account.
          mail({
            id: `b-${n}-more`,
            conversation: `b-t${n}`,
            from: ANA,
            to: ["me@b.example"],
            at: at + 3 * HOUR,
          }),
        ],
        "b",
      );
    }

    const card = await read(store, { accountIds: ["a", "b"] });

    expect(card.conversations).toHaveLength(6);
    expect(card.replyLag).toEqual({
      theirs: { medianMs: 2 * HOUR, exchanges: 3 },
      yours: { medianMs: HOUR, exchanges: 3 },
    });
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
