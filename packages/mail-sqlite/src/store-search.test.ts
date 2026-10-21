import { describe, expect, it } from "vitest";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import type { SqliteDriver } from "./driver";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

const MESSAGES = [
  {
    id: "html",
    subject: "Weekly digest",
    from: "Billing <billing@acme.example>",
    to: ["Ada Lovelace <ada@example.com>"],
    read: false,
    text: null,
    html: `<html><head><style>.font-large { color: red }</style></head><body>
      <table style="font-family:Arial"><tr><td>Quarterly <b>invoice</b> attached</td></tr></table>
      </body></html>`,
  },
  {
    id: "text",
    subject: "Invoice reminder",
    from: "ada@example.com",
    to: ["me@example.com", "grace@example.com"],
    read: true,
    text: "Payment for the quarterly review",
    html: null,
  },
  {
    id: "lunch",
    subject: "Lunch",
    from: "grace@example.com",
    to: ["me@example.com"],
    read: false,
    text: "Tacos on Friday",
    html: null,
  },
  {
    id: "bare",
    subject: "Parking notice",
    from: "facilities@example.com",
    to: ["me@example.com"],
    read: false,
    text: null,
    html: null,
  },
];

const VARIANT_MESSAGES = [
  {
    id: "power",
    subject: "Electricity bill",
    text: "Your monthly invoices are ready",
    attachments: [],
  },
  {
    id: "router",
    subject: "Router setup",
    text: "The Wi-Fi password changed",
    attachments: [],
  },
  {
    id: "hotspot",
    subject: "Hotspot",
    text: "Free wifi in the lobby",
    attachments: [],
  },
  {
    id: "factura",
    subject: "Facturas pendientes",
    text: "Adjunto las facturas del mes",
    attachments: [],
  },
  {
    id: "mitsumori",
    subject: "見積書の送付",
    text: "ご確認ください",
    attachments: [],
  },
  {
    id: "scan",
    subject: "Scanned documents",
    text: "See attached",
    attachments: [
      attachment("contract-2026.pdf", "application/pdf"),
      attachment("logo.png", "image/png", true),
      attachment("scan", "image/jpeg"),
    ],
  },
];

describe("local text search", () => {
  it("matches words from an HTML-only body but not its markup", async () => {
    const { store, close } = await searchableMailbox();

    expect(await search(store, text("any", "attached"))).toEqual(["html"]);
    expect(await search(store, text("any", "font"))).toEqual([]);
    expect(await search(store, text("any", "table"))).toEqual([]);
    expect(await search(store, text("any", "red"))).toEqual([]);
    await close();
  });

  it("matches words as they are typed and requires every term", async () => {
    const { store, close } = await searchableMailbox();

    expect(await search(store, text("any", "quar"))).toEqual(["html", "text"]);
    expect(await search(store, text("any", "invoice attach"))).toEqual([
      "html",
    ]);
    expect(await search(store, text("any", "quarterly tacos"))).toEqual([]);
    await close();
  });

  it("reads search syntax and punctuation in the input as plain text", async () => {
    const { store, close } = await searchableMailbox();

    for (const value of [
      '"',
      '"tacos',
      "tacos OR",
      "NOT tacos",
      "subject:lunch",
      "body : tacos",
      "*",
      "(",
      "^tacos",
      "NEAR(tacos)",
      "tacos -friday",
      "...",
    ]) {
      await expect(search(store, text("any", value))).resolves.toBeDefined();
    }
    expect(await search(store, text("any", "tacos!"))).toEqual(["lunch"]);
    expect(await search(store, text("any", '"tacos"'))).toEqual(["lunch"]);
    expect(await search(store, text("any", "..."))).toEqual([]);
    await close();
  });

  it("keeps field filters to their field", async () => {
    const { store, close } = await searchableMailbox();

    expect(await search(store, text("subject", "invoice"))).toEqual(["text"]);
    expect(await search(store, text("body", "invoice"))).toEqual(["html"]);
    expect(
      await search(store, {
        kind: "all",
        predicates: [
          address("from", "billing@acme.example"),
          text("any", "quarterly"),
        ],
      }),
    ).toEqual(["html"]);
    expect(
      await search(store, {
        kind: "not",
        predicate: text("any", "quarterly"),
      }),
    ).toEqual(["bare", "lunch"]);
    await close();
  });

  it("matches recipients for a to: search", async () => {
    const { store, close } = await searchableMailbox();

    expect(await search(store, address("to", "ada@example.com"))).toEqual([
      "html",
    ]);
    expect(await search(store, address("to", "grace@example.com"))).toEqual([
      "text",
    ]);
    expect(await search(store, address("to", "me@example.com"))).toEqual([
      "bare",
      "lunch",
      "text",
    ]);
    await close();
  });

  it("finds mail synced without a body by its current subject", async () => {
    const { store, close } = await searchableMailbox();
    expect(await search(store, text("any", "parking"))).toEqual(["bare"]);

    await renameSubject(store, "bare", "Garage notice");

    expect(await search(store, text("any", "garage"))).toEqual(["bare"]);
    expect(await search(store, text("any", "parking"))).toEqual([]);
    await close();
  });

  it("finds mail with a stored body by its current subject and its body", async () => {
    const { store, close } = await searchableMailbox();

    await renameSubject(store, "lunch", "Brunch");
    expect(await search(store, text("any", "brunch"))).toEqual(["lunch"]);

    await drainBacklog(store);
    expect(await search(store, text("any", "brunch"))).toEqual(["lunch"]);
    expect(await search(store, text("subject", "lunch"))).toEqual([]);
    expect(await search(store, text("any", "tacos"))).toEqual(["lunch"]);
    await close();
  });

  it("counts matching and unread conversations for a search", async () => {
    const { store, close } = await searchableMailbox();

    const { view } = await store.readMailboxView(query(text("any", "quar")));
    expect(view.counts).toMatchObject({
      matchingConversations: 2,
      unreadConversations: 1,
    });
    await close();
  });

  it("finds messages the index has not reached yet by subject, and by body once indexed", async () => {
    const { driver, close } = await searchableMailbox();
    // Reopening after forgetting the latest index migration rebuilds it empty.
    await driver.write((tx) =>
      tx.execute("DELETE FROM schema_migrations WHERE id = 12"),
    );
    const reopened = await createSqliteMailStore(driver);

    expect(await search(reopened, text("any", "lunch"))).toEqual(["lunch"]);
    expect(await search(reopened, text("any", "tacos"))).toEqual([]);
    expect(await search(reopened, text("subject", "parking"))).toEqual([
      "bare",
    ]);
    expect(await search(reopened, text("any", "attached"))).toEqual([]);

    await drainBacklog(reopened);
    expect(await search(reopened, text("any", "attached"))).toEqual(["html"]);
    expect(await search(reopened, text("any", "parking"))).toEqual(["bare"]);
    expect(await search(reopened, text("any", "tacos"))).toEqual(["lunch"]);
    await close();
  });

  it("keeps finding mail by subject after bodies are evicted", async () => {
    const { store, close } = await searchableMailbox();

    await store.evictReplaceableContent();
    expect(await search(store, text("any", "digest"))).toEqual(["html"]);
    await drainBacklog(store);
    expect(await search(store, text("any", "digest"))).toEqual(["html"]);
    expect(await search(store, text("any", "attached"))).toEqual([]);
    await close();
  });

  it("lists a typed search's index hits next to the messages the provider matched", async () => {
    const { store, close } = await searchableMailbox();
    // The shape resolveSearchPredicates gives a search with matches.
    const providerMatched = (
      rest: MailPredicate[],
      matchedIn = "acc-1",
    ): MailPredicate => ({
      kind: "all",
      predicates: [
        {
          kind: "any",
          predicates: [
            {
              kind: "all",
              predicates: [text("any", "quarterly"), ...rest],
            },
            {
              kind: "all",
              predicates: [
                { kind: "not", predicate: { kind: "role", role: "trash" } },
                {
                  kind: "any",
                  predicates: [
                    { kind: "message", accountId: matchedIn, ids: ["bare"] },
                    { kind: "message", accountId: "other", ids: ["lunch"] },
                  ],
                },
              ],
            },
          ],
        },
        { kind: "not", predicate: { kind: "role", role: "spam" } },
      ],
    });

    expect(await search(store, providerMatched([]))).toEqual([
      "bare",
      "html",
      "text",
    ]);
    // A hit must still pass the rest of the local search; a provider match
    // needn't.
    expect(
      await search(store, providerMatched([{ kind: "read", value: false }])),
    ).toEqual(["bare", "html"]);
    expect(
      await store.readMailboxView(query(providerMatched([]))),
    ).toMatchObject({ view: { counts: { matchingConversations: 3 } } });
    // Another account's match with the same id isn't this account's mail.
    expect(await search(store, providerMatched([], "other"))).toEqual([
      "html",
      "text",
    ]);
    await close();
  });
});

describe("word variants and attachments", () => {
  it("matches other forms of a word", async () => {
    const { store, close } = await variantMailbox();

    expect(await search(store, text("any", "electric"))).toEqual(["power"]);
    expect(await search(store, text("any", "electricity bills"))).toEqual([
      "power",
    ]);
    expect(await search(store, text("any", "invoice"))).toEqual(["power"]);
    expect(await search(store, text("subject", "factura"))).toEqual([
      "factura",
    ]);
    await close();
  });

  it("matches hyphenated, spaced, and joined spellings of a compound", async () => {
    const { store, close } = await variantMailbox();

    for (const value of ["wifi", "Wi-Fi", "wi fi", "WiFi password"]) {
      expect(await search(store, text("any", value))).toEqual(
        value === "WiFi password" ? ["router"] : ["hotspot", "router"],
      );
    }
    expect(
      await search(store, {
        kind: "text",
        field: "body",
        value: "wi-fi password",
        match: "phrase",
      }),
    ).toEqual(["router"]);
    await close();
  });

  it("keeps matching scripts written without spaces", async () => {
    const { store, close } = await variantMailbox();

    expect(await search(store, text("any", "見積"))).toEqual(["mitsumori"]);
    expect(await search(store, text("any", "確認"))).toEqual(["mitsumori"]);
    await close();
  });

  it("matches attachment file names and types but not inline images", async () => {
    const { store, close } = await variantMailbox();

    expect(await search(store, text("any", "contract-2026.pdf"))).toEqual([
      "scan",
    ]);
    expect(await search(store, text("any", "contract"))).toEqual(["scan"]);
    expect(await search(store, text("any", "pdf"))).toEqual(["scan"]);
    expect(await search(store, text("any", "jpeg"))).toEqual(["scan"]);
    expect(await search(store, text("any", "png"))).toEqual([]);
    expect(await search(store, text("any", "logo"))).toEqual([]);
    expect(await search(store, text("body", "pdf"))).toEqual([]);
    await close();
  });

  it("rebuilds an index written before variants and attachments", async () => {
    const { driver } = await variantMailbox();
    await driver.write(async (tx) => {
      await tx.exec(
        `DROP TABLE message_fts;
         CREATE VIRTUAL TABLE message_fts USING fts5(subject, preview, from_address, body, content = '', contentless_delete = 1, tokenize = 'unicode61');
         DELETE FROM schema_migrations WHERE id = 12;`,
      );
    });

    const reopened = await createSqliteMailStore(driver);
    await drainBacklog(reopened);
    expect(await search(reopened, text("any", "invoice"))).toEqual(["power"]);
    expect(await search(reopened, text("any", "pdf"))).toEqual(["scan"]);
    await reopened.close();
  });
});

function attachment(filename: string, mimeType: string, inline = false) {
  return {
    attachmentId: `att-${filename}`,
    filename,
    mimeType,
    size: 100,
    inline,
  };
}

async function variantMailbox(): Promise<{
  store: MailStore;
  driver: SqliteDriver;
  close: () => Promise<void>;
}> {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "bootstrap",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: VARIANT_MESSAGES.map((message, index) =>
        messagePatch(
          {
            ...message,
            from: "sender@example.com",
            to: ["me@example.com"],
            read: true,
            html: null,
          },
          index,
        ),
      ),
      requiredHydration: [],
      roundComplete: true,
    },
    bodies: VARIANT_MESSAGES.map((message) => ({
      key: { accountId: "acc-1", messageId: message.id },
      version: "1",
      text: message.text,
      html: null,
      attachments: message.attachments,
    })),
  });
  await drainBacklog(store);
  return { store, driver, close: () => store.close() };
}

function text(field: "any" | "subject" | "body", value: string): MailPredicate {
  return { kind: "text", field, value, match: "term" };
}

function address(field: "from" | "to", value: string): MailPredicate {
  return { kind: "address", field, value, match: "address" };
}

async function search(store: MailStore, predicate: MailPredicate) {
  const result = await store.readMailboxView(query(predicate));
  return result.view.conversations
    .map((conversation) => conversation.key.conversationId)
    .sort();
}

function query(predicate: MailPredicate) {
  return {
    accountIds: ["acc-1"],
    predicate,
    order: "newest_first" as const,
    pageSize: 25,
    after: null,
  };
}

async function searchableMailbox(): Promise<{
  store: MailStore;
  driver: SqliteDriver;
  close: () => Promise<void>;
}> {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  await store.ensureAccount({
    accountId: "acc-1",
    provider: "google",
    generation: "g1",
  });
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: "bootstrap",
      from: { streamId: "primary", generation: "g1", checkpoint: null },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: MESSAGES.map((message, index) => messagePatch(message, index)),
      requiredHydration: [],
      roundComplete: true,
    },
    bodies: MESSAGES.filter(
      (message) => message.text !== null || message.html !== null,
    ).map((message) => ({
      key: { accountId: "acc-1", messageId: message.id },
      version: "1",
      text: message.text,
      html: message.html,
    })),
  });
  await drainBacklog(store);
  return { store, driver, close: () => store.close() };
}

async function renameSubject(store: MailStore, id: string, subject: string) {
  const index = MESSAGES.findIndex((message) => message.id === id);
  const patch = messagePatch({ ...MESSAGES[index], subject }, index);
  await store.applySyncPage({
    ownerId: "owner",
    page: {
      session: { accountId: "acc-1", generation: "g1" },
      requestId: `rename-${id}`,
      from: { streamId: "primary", generation: "g1", checkpoint: "1" },
      to: { streamId: "primary", generation: "g1", checkpoint: "1" },
      changes: [{ ...patch, reference: { ...patch.reference, version: "2" } }],
      requiredHydration: [],
      roundComplete: true,
    },
  });
}

async function drainBacklog(store: MailStore) {
  while ((await store.indexSearchBacklog()).remaining) {
    // keep indexing
  }
}

function messagePatch(
  message: Pick<
    (typeof MESSAGES)[number],
    "id" | "subject" | "from" | "to" | "read"
  >,
  index: number,
): Extract<ProviderChange, { kind: "message_patch" }> {
  return {
    kind: "message_patch",
    key: { accountId: "acc-1", messageId: message.id },
    reference: {
      provider: "google",
      messageId: message.id,
      conversationId: message.id,
      version: "1",
    },
    fields: {
      subject: message.subject,
      preview: "",
      from: message.from,
      to: message.to,
      cc: [],
      receivedAtMs: index,
      read: message.read,
      starred: false,
      folderId: "inbox",
      labelIds: ["INBOX"],
      categoryIds: [],
      roles: ["inbox"],
      hasAttachments: false,
    },
  };
}
