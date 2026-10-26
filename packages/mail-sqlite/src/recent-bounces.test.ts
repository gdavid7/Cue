import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { RecentBouncesQuery } from "@inboxzero/mail-core/queries";
import type {
  BodyObservation,
  ProviderChange,
} from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { BOUNCE_CANDIDATES_SQL, isBounceSender } from "./recent-bounces";
import { createSqliteMailStore } from "./store";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = 1_800_000_000_000;
const SINCE = NOW - 7 * DAY;
const ME = "me@example.com";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("isBounceSender", () => {
  it.each([
    "mailer-daemon@googlemail.com",
    "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    "MAILER-DAEMON@mx.example.org",
    "Mailer-Daemon <Mailer-Daemon@Mail.Example.CO.UK>",
    "postmaster@outlook.com",
    "Mail Delivery System <POSTMASTER@corp.example>",
    "postmaster@a.b.example",
    "MAILER-DAEMON",
    '"mailer-daemon"@example.com',
    "mailer-daemon+bounce-id@example.com",
  ])("counts %s", (from) => {
    expect(isBounceSender(from)).toBe(true);
  });

  it.each([
    "",
    "alice@example.com",
    "Postmaster General <alice@example.com>",
    "mailer-daemon-fan@example.com",
    "not-postmaster@example.com",
    "postmasters@example.com",
    "noreply@mailer-daemon.example",
    "bounce@esp.example",
  ])("doesn't count %s", (from) => {
    expect(isBounceSender(from)).toBe(false);
  });
});

describe("readRecentBounces", () => {
  it("lists a bounce from a mailer-daemon or postmaster address on any domain", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "daemon",
        from: "Mail Delivery Subsystem <MAILER-DAEMON@googlemail.com>",
        subject: "Delivery Status Notification (Failure)",
        at: NOW - HOUR,
      }),
      mail({
        id: "postmaster",
        from: "postmaster@mail.example.org",
        subject: "Non remis : Lunch",
        at: NOW - 2 * HOUR,
      }),
    ]);

    expect(await read(store)).toEqual([
      {
        accountId: "a",
        conversationId: "daemon",
        messageId: "daemon",
        subject: "Delivery Status Notification (Failure)",
        sentSubject: null,
        receivedAtMs: NOW - HOUR,
        answeredAfter: false,
      },
      {
        accountId: "a",
        conversationId: "postmaster",
        messageId: "postmaster",
        subject: "Non remis : Lunch",
        sentSubject: null,
        receivedAtMs: NOW - 2 * HOUR,
        answeredAfter: false,
      },
    ]);
  });

  it("doesn't count ordinary mail that talks about undeliverable mail", async () => {
    const { store } = await setup();
    await write(
      store,
      [
        mail({
          id: "talk",
          from: "Alice <alice@example.com>",
          subject: "Undeliverable: Mail delivery failed",
          preview:
            "Delivery Status Notification. Your message was undeliverable; returning to sender.",
        }),
      ],
      [
        {
          key: { accountId: "a", messageId: "talk" },
          version: "1",
          html: null,
          text: "Undeliverable. Delivery has failed to these recipients. Content-Type: multipart/report; report-type=delivery-status",
          attachments: [],
        },
      ],
    );

    expect(await read(store)).toEqual([]);
  });

  it("names what the user sent in the conversation before it bounced", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "sent",
        conversationId: "c1",
        from: ME,
        subject: "Quarterly plan",
        roles: ["sent"],
        at: NOW - 3 * HOUR,
      }),
      mail({
        id: "bounce",
        conversationId: "c1",
        from: "mailer-daemon@googlemail.com",
        subject: "Delivery Status Notification (Failure)",
        at: NOW - 2 * HOUR,
      }),
    ]);

    expect(await read(store)).toMatchObject([
      {
        conversationId: "c1",
        messageId: "bounce",
        sentSubject: "Quarterly plan",
      },
    ]);
  });

  it("shows a conversation once, by its newest bounce", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "delay",
        conversationId: "c1",
        from: "mailer-daemon@x.example",
        at: NOW - 5 * HOUR,
      }),
      mail({
        id: "failure",
        conversationId: "c1",
        from: "mailer-daemon@x.example",
        at: NOW - HOUR,
      }),
    ]);

    expect((await read(store)).map((bounce) => bounce.messageId)).toEqual([
      "failure",
    ]);
  });

  it("says when someone else wrote in the conversation after the bounce", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "sent",
        conversationId: "c1",
        from: ME,
        roles: ["sent"],
        at: NOW - 4 * HOUR,
      }),
      mail({
        id: "bounce",
        conversationId: "c1",
        from: "mailer-daemon@x.example",
        at: NOW - 3 * HOUR,
      }),
      mail({
        id: "reply",
        conversationId: "c1",
        from: "Alice <alice@example.com>",
        at: NOW - HOUR,
      }),
      mail({
        id: "sent2",
        conversationId: "c2",
        from: ME,
        roles: ["sent"],
        at: NOW - 4 * HOUR,
      }),
      mail({
        id: "before",
        conversationId: "c2",
        from: "Bob <bob@example.com>",
        at: NOW - 3 * HOUR,
      }),
      mail({
        id: "bounce2",
        conversationId: "c2",
        from: "postmaster@x.example",
        at: NOW - 2 * HOUR,
      }),
    ]);

    expect(
      (await read(store)).map((bounce) => [
        bounce.messageId,
        bounce.answeredAfter,
      ]),
    ).toEqual([
      ["bounce2", false],
      ["bounce", true],
    ]);
  });

  it("leaves a bounce out once the user sent in the conversation since", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "bounce",
        conversationId: "c1",
        from: "postmaster@x.example",
        at: NOW - 3 * HOUR,
      }),
      mail({
        id: "again",
        conversationId: "c1",
        from: ME,
        roles: ["sent"],
        at: NOW - HOUR,
      }),
    ]);

    expect(await read(store)).toEqual([]);
  });

  it("fills the limit past bounces the user already sent again after", async () => {
    const { store } = await setup();
    await write(store, [
      mail({
        id: "fixed",
        conversationId: "c1",
        from: "postmaster@x.example",
        at: NOW - HOUR,
      }),
      mail({
        id: "again",
        conversationId: "c1",
        from: ME,
        roles: ["sent"],
        at: NOW - HOUR / 2,
      }),
      mail({
        id: "open",
        conversationId: "c2",
        from: "postmaster@x.example",
        at: NOW - 2 * HOUR,
      }),
    ]);

    expect(
      (await read(store, { limit: 1 })).map((bounce) => bounce.messageId),
    ).toEqual(["open"]);
  });

  it("only lists recent bounces still in the inbox", async () => {
    const { store } = await setup();
    await write(store, [
      mail({ id: "old", from: "mailer-daemon@x.example", at: SINCE - HOUR }),
      mail({ id: "archived", from: "mailer-daemon@x.example", roles: [] }),
      mail({
        id: "trashed",
        from: "mailer-daemon@x.example",
        roles: ["trash"],
      }),
      mail({
        id: "spam",
        from: "mailer-daemon@x.example",
        roles: ["inbox", "spam"],
      }),
      mail({ id: "kept", from: "mailer-daemon@x.example" }),
    ]);

    expect((await read(store)).map((bounce) => bounce.messageId)).toEqual([
      "kept",
    ]);
  });

  it("reads each asked account, newest first across them, up to the limit", async () => {
    const { store } = await setup(["a", "b", "c"]);
    await write(
      store,
      [mail({ id: "a1", from: "postmaster@x.example", at: NOW - 3 * HOUR })],
      [],
      "a",
    );
    await write(
      store,
      [mail({ id: "b1", from: "postmaster@x.example", at: NOW - HOUR })],
      [],
      "b",
    );
    await write(
      store,
      [mail({ id: "c1", from: "postmaster@x.example", at: NOW - 2 * HOUR })],
      [],
      "c",
    );

    expect(
      (await read(store, { accountIds: ["a", "b"] })).map((bounce) => [
        bounce.accountId,
        bounce.messageId,
      ]),
    ).toEqual([
      ["b", "b1"],
      ["a", "a1"],
    ]);
    expect(
      (await read(store, { accountIds: ["a", "b", "c"], limit: 2 })).map(
        (bounce) => bounce.messageId,
      ),
    ).toEqual(["b1", "c1"]);
  });

  it("reads the window through the inbox index", async () => {
    const { driver } = await setup();
    const plan = await driver.read((tx) =>
      tx.query(`EXPLAIN QUERY PLAN ${BOUNCE_CANDIDATES_SQL}`, ["a", SINCE]),
    );
    const details = plan.map((row) => String(row.detail));

    expect(details).toContainEqual(
      expect.stringMatching(
        /^SEARCH effective_messages USING INDEX effective_inbox_order \(account_id=\? AND in_inbox=\? AND received_at_ms>\?\)/,
      ),
    );
    expect(
      details.some((detail) => /^SCAN (b|effective_messages)\b/.test(detail)),
    ).toBe(false);
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

function read(store: MailStore, input: Partial<RecentBouncesQuery> = {}) {
  return store.readRecentBounces({
    accountIds: ["a"],
    receivedSinceMs: SINCE,
    limit: 10,
    ...input,
  });
}

async function write(
  store: MailStore,
  changes: ProviderChange[],
  bodies: BodyObservation[] = [],
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
      bodies: bodies.map((item) => ({
        ...item,
        key: { ...item.key, accountId },
      })),
    }),
  ).toMatchObject({ status: "committed" });
}

function mail({
  id,
  conversationId = id,
  from,
  subject = "",
  preview = "",
  at = NOW - DAY,
  roles = ["inbox"],
}: {
  id: string;
  conversationId?: string;
  from: string;
  subject?: string;
  preview?: string;
  at?: number;
  roles?: ("inbox" | "trash" | "spam" | "draft" | "sent")[];
}): ProviderChange {
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
      from,
      to: [ME],
      cc: [],
      receivedAtMs: at,
      roles,
      subject,
      preview,
      read: false,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
