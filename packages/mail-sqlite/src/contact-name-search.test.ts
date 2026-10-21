import { afterEach, describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { migrateMailbox } from "./migrations";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const ME = "Sam Owner <me@example.com>";
const DANA = "Dana Ruiz <dana@acme.example>";

const stores: MailStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
});

describe("searching for a person by name", () => {
  it.each([
    ["indexed", true],
    ["still indexing", false],
  ])("finds mail to and from them that never names them (%s)", async (_label, indexed) => {
    const { store } = await setup(
      [
        message("to-dana", { from: ME, to: [DANA], sent: true }),
        message("from-dana", { from: "dana@acme.example" }),
        message("cc-dana", {
          from: "lee@acme.example",
          to: [ME],
          cc: ["dana@acme.example"],
        }),
        message("unrelated", { from: "lee@acme.example" }),
      ],
      { indexed },
    );

    for (const typed of ["dana", "Dana", "DAN", "ruiz"])
      expect(await conversations(store, text(typed)), typed).toEqual([
        "cc-dana",
        "from-dana",
        "to-dana",
      ]);
    expect(await messages(store, text("dana"))).toEqual([
      "cc-dana",
      "from-dana",
      "to-dana",
    ]);
  });

  it("ignores accents and case either way", async () => {
    const { store } = await setup([
      message("to-jose", {
        from: ME,
        to: ["José Núñez <jose@acme.example>"],
        sent: true,
      }),
      message("from-jose", { from: "jose@acme.example" }),
    ]);

    for (const typed of ["jose", "JOSÉ", "nunez", "Núñ"])
      expect(await conversations(store, text(typed)), typed).toEqual([
        "from-jose",
        "to-jose",
      ]);
  });

  it("needs mail you sent them, so a name a stranger uses finds only its own text", async () => {
    const { store } = await setup([
      message("pat-named", { from: "Pat Stone <pat@acme.example>" }),
      message("pat-bare", { from: "pat@acme.example", subject: "Hello" }),
      message("to-dana", { from: ME, to: [DANA], sent: true }),
      // Borrows Dana's name; you never wrote to this address.
      message("spoof", { from: "Dana Ruiz <x9@spoof.example>" }),
      message("spoof-reply", {
        from: "x9@spoof.example",
        subject: "Following up",
      }),
    ]);

    expect(await conversations(store, text("stone"))).toEqual(["pat-named"]);
    expect(await conversations(store, text("dana"))).toEqual([
      "spoof",
      "to-dana",
    ]);
  });

  it("does not read your own name as a person, on any address you send from", async () => {
    const work = "Sam Owner <sam@work.example>";
    const { store } = await setup([
      message("to-work", { from: ME, to: [work], sent: true }),
      message("from-work", { from: work, to: [DANA], sent: true }),
      message("lee-to-me", { from: "lee@acme.example", to: [ME] }),
      message("lee-to-work", { from: "lee@acme.example", to: [work] }),
    ]);

    expect(await conversations(store, text("owner"))).toEqual([
      "from-work",
      "to-work",
    ]);
  });

  it("matches the other words as text alongside the name", async () => {
    const { store } = await setup([
      message("to-dana", {
        from: ME,
        to: [DANA],
        sent: true,
        subject: "Budget for March",
      }),
      message("dana-lunch", { from: "dana@acme.example", subject: "Lunch" }),
      message("budget", { from: "lee@acme.example", subject: "Budget" }),
    ]);

    expect(await conversations(store, text("dana budget"))).toEqual([
      "to-dana",
    ]);
    expect(await conversations(store, text("budget dana"))).toEqual([
      "to-dana",
    ]);
    expect(await conversations(store, text("dana ruiz"))).toEqual([
      "dana-lunch",
      "to-dana",
    ]);
    expect(await messages(store, text("dana lunch"))).toEqual(["dana-lunch"]);
  });

  it("keeps a phrase, a subject search and a negation to their text", async () => {
    const { store } = await setup([
      message("to-dana", { from: ME, to: [DANA], sent: true }),
      message("from-dana", { from: "dana@acme.example" }),
    ]);

    expect(
      await conversations(store, {
        kind: "text",
        field: "any",
        value: "dana",
        match: "phrase",
      }),
    ).toEqual(["from-dana"]);
    expect(
      await conversations(store, {
        kind: "text",
        field: "subject",
        value: "dana",
        match: "term",
      }),
    ).toEqual([]);
    expect(
      await conversations(store, {
        kind: "all",
        predicates: [
          { kind: "mailbox", mailbox: "all" },
          { kind: "not", predicate: text("dana") },
        ],
      }),
    ).toEqual(["to-dana"]);
  });

  it("answers a typed search with the provider's matches beside it", async () => {
    const { store } = await setup([
      message("from-dana", { from: "dana@acme.example" }),
      message("to-dana", { from: ME, to: [DANA], sent: true }),
      message("provider-only", { from: "lee@acme.example" }),
    ]);

    expect(
      await conversations(store, {
        kind: "any",
        predicates: [
          text("dana"),
          { kind: "message", ids: ["provider-only"], accountId: "a" },
        ],
      }),
    ).toEqual(["from-dana", "provider-only", "to-dana"]);
  });

  it("finds people indexed before names were, once the store opens again", async () => {
    const { store, driver } = await setup([
      message("to-dana", { from: ME, to: [DANA], sent: true }),
      message("from-dana", { from: "dana@acme.example" }),
    ]);
    await driver.write(async (tx) => {
      await tx.exec("DROP TABLE contact_name_tokens");
      await migrateMailbox(tx, "ignored");
    });

    expect(await conversations(store, text("dana"))).toEqual([
      "from-dana",
      "to-dana",
    ]);
  });
});

function text(value: string): MailPredicate {
  return { kind: "text", field: "any", value, match: "term" };
}

async function conversations(store: MailStore, predicate: MailPredicate) {
  const result = await store.readMailboxView({
    accountIds: ["a"],
    predicate,
    order: "newest_first",
    pageSize: 25,
    after: null,
  });
  return result.view.conversations
    .map((conversation) => conversation.key.conversationId)
    .sort();
}

async function messages(store: MailStore, predicate: MailPredicate) {
  const page = await store.readMessageSearch({
    accountId: "a",
    predicate,
    fromAddress: null,
    pageSize: 25,
    after: null,
  });
  return page.messages.map((match) => match.messageId).sort();
}

async function setup(
  changes: ProviderChange[],
  { indexed = true }: { indexed?: boolean } = {},
): Promise<{ store: MailStore; driver: SqliteDriver }> {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  stores.push(store);
  await store.ensureAccount({
    accountId: "a",
    provider: "google",
    generation: "g",
  });
  expect(
    await store.applyHydration({
      session: { accountId: "a", generation: "g" },
      requestId: "test",
      changes,
      bodies: [],
    }),
  ).toMatchObject({ status: "committed" });
  if (indexed)
    while ((await store.indexSearchBacklog()).remaining) {
      // keep indexing
    }
  return { store, driver };
}

let receivedAtMs = 1_800_000_000_000;

function message(
  id: string,
  fields: {
    from: string;
    to?: string[];
    cc?: string[];
    subject?: string;
    sent?: boolean;
  },
): ProviderChange {
  receivedAtMs += 60_000;
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
      from: fields.from,
      to: fields.to ?? [ME],
      cc: fields.cc ?? [],
      receivedAtMs,
      roles: fields.sent ? ["sent"] : ["inbox"],
      subject: fields.subject ?? "",
      preview: "",
      read: true,
      starred: false,
      folderId: null,
      labelIds: fields.sent ? ["SENT"] : ["INBOX"],
      categoryIds: [],
      hasAttachments: false,
    },
  };
}
