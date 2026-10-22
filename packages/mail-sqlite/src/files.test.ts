import { describe, expect, it } from "vitest";
import type { MessageAttachmentDescriptor } from "@inboxzero/mail-core/messages";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import type { FilesQuery } from "@inboxzero/mail-core/queries";
import type { ProviderChange } from "@inboxzero/mail-core/sync";
import { clearSearchIndex } from "./message-search-index";
import { createNodeSqliteDriver } from "./node-sqlite";
import { createSqliteMailStore } from "./store";

type Seed = {
  id: string;
  conversation?: string;
  account?: string;
  from?: string;
  subject?: string;
  roles?: ("inbox" | "trash" | "spam" | "draft" | "sent")[];
  attachments: MessageAttachmentDescriptor[];
  /** Listed with attachments, but its body was never downloaded. */
  bodyless?: boolean;
};

const MAILBOX: Seed[] = [
  {
    id: "contract",
    from: "Ana Lima <ana@example.com>",
    subject: "Signed contract",
    attachments: [
      file("Contract-2026.pdf", "application/octet-stream"),
      file("logo.png", "image/png", true),
    ],
  },
  {
    id: "budget",
    from: "Ben <ben@example.com>",
    subject: "Budget",
    attachments: [
      file("Q3 budget.xlsx", "application/octet-stream"),
      file("Board deck.pptx", "application/vnd.ms-powerpoint"),
      file("notes.docx", "application/msword"),
    ],
  },
  {
    id: "photos",
    from: "ana@example.com",
    subject: "Trip",
    attachments: [
      file("IMG_0001.HEIC", "image/heic"),
      file("route.gpx", "application/gpx+xml"),
    ],
  },
  {
    id: "invoices",
    from: "Billing <billing@acme.example>",
    subject: "Your invoices",
    attachments: [
      file("invoice-march.pdf", "application/pdf"),
      file("terms.pdf", "application/pdf"),
    ],
  },
  {
    id: "deleted",
    subject: "Old",
    roles: ["trash"],
    attachments: [file("trashed.pdf", "application/pdf")],
  },
  {
    id: "draft",
    subject: "Draft",
    roles: ["draft"],
    attachments: [file("draft.pdf", "application/pdf")],
  },
  {
    id: "other-account",
    account: "acc-2",
    from: "Ana Lima <ana@example.com>",
    subject: "From work",
    attachments: [file("work.pdf", "application/pdf")],
  },
];

describe("readFiles", () => {
  it("lists every real attachment newest first, leaving out inline images, trash and drafts", async () => {
    const store = await filesMailbox();

    const page = await store.readFiles(query());
    expect(page.files.map((entry) => entry.attachment.filename)).toEqual([
      "invoice-march.pdf",
      "terms.pdf",
      "IMG_0001.HEIC",
      "route.gpx",
      "Q3 budget.xlsx",
      "Board deck.pptx",
      "notes.docx",
      "Contract-2026.pdf",
    ]);
    expect(page.files[0]).toMatchObject({
      accountId: "acc-1",
      conversationId: "invoices",
      messageId: "invoices",
      subject: "Your invoices",
      from: "Billing <billing@acme.example>",
      kind: "pdf",
    });
    await store.close();
  });

  it("groups files by kind from their type or, when the type is generic, their name", async () => {
    const store = await filesMailbox();

    const kinds = Object.fromEntries(
      (await store.readFiles(query())).files.map((entry) => [
        entry.attachment.filename,
        entry.kind,
      ]),
    );
    expect(kinds).toMatchObject({
      "Contract-2026.pdf": "pdf",
      "Q3 budget.xlsx": "spreadsheet",
      "Board deck.pptx": "presentation",
      "notes.docx": "document",
      "IMG_0001.HEIC": "image",
      "route.gpx": "other",
    });
    expect(await names(store, { kind: "pdf" })).toEqual([
      "invoice-march.pdf",
      "terms.pdf",
      "Contract-2026.pdf",
    ]);
    expect(await names(store, { kind: "image" })).toEqual(["IMG_0001.HEIC"]);
    await store.close();
  });

  it("filters by sender address whatever name it was sent under", async () => {
    const store = await filesMailbox();

    expect(await names(store, { sender: "ANA@example.com" })).toEqual([
      "IMG_0001.HEIC",
      "route.gpx",
      "Contract-2026.pdf",
    ]);
    await store.close();
  });

  it("finds files by name through the search index, including other word forms", async () => {
    const store = await filesMailbox();

    expect(await names(store, { name: "contract" })).toEqual([
      "Contract-2026.pdf",
    ]);
    // "invoices" finds "invoice-march.pdf" but not its sibling "terms.pdf".
    expect(await names(store, { name: "invoices" })).toEqual([
      "invoice-march.pdf",
    ]);
    expect(await names(store, { name: "budget xlsx" })).toEqual([
      "Q3 budget.xlsx",
    ]);
    expect(await names(store, { name: "logo" })).toEqual([]);
    expect(await names(store, { name: "nothing-like-this" })).toEqual([]);
    expect(await names(store, { name: '"' })).toEqual([]);
    await store.close();
  });

  it("finds files by a one-letter search, which the search index can't match", async () => {
    for (const indexed of [true, false]) {
      const store = await filesMailbox({ indexed });

      expect(await names(store, { name: "q" })).toEqual(["Q3 budget.xlsx"]);
      expect(await names(store, { name: "X" })).toEqual([
        "route.gpx",
        "Q3 budget.xlsx",
        "Board deck.pptx",
        "notes.docx",
      ]);
      expect(await names(store, { name: "q 3 budget" })).toEqual([
        "Q3 budget.xlsx",
      ]);
      expect(await names(store, { name: "q", kind: "pdf" })).toEqual([]);
      await store.close();
    }
  });

  it("keeps the index for a search whose only one-character token is punctuation", async () => {
    const store = await filesMailbox();

    expect(await names(store, { name: "contract ." })).toEqual([
      "Contract-2026.pdf",
    ]);
    expect(await names(store, { name: "." })).toEqual([]);
    await store.close();
  });

  it("combines filters", async () => {
    const store = await filesMailbox();

    expect(
      await names(store, { sender: "ana@example.com", kind: "pdf" }),
    ).toEqual(["Contract-2026.pdf"]);
    expect(await names(store, { kind: "pdf", name: "terms" })).toEqual([
      "terms.pdf",
    ]);
    await store.close();
  });

  it("merges every listed account and pages without repeating or skipping a file", async () => {
    const store = await filesMailbox();

    const all: string[] = [];
    let after: string | null = null;
    do {
      const page = await store.readFiles(
        query({ accountIds: ["acc-1", "acc-2"], pageSize: 3, after }),
      );
      expect(page.files.length).toBeLessThanOrEqual(3);
      all.push(...page.files.map((entry) => entry.attachment.filename));
      after = page.nextPage;
    } while (after);
    expect(all).toEqual([
      "work.pdf",
      "invoice-march.pdf",
      "terms.pdf",
      "IMG_0001.HEIC",
      "route.gpx",
      "Q3 budget.xlsx",
      "Board deck.pptx",
      "notes.docx",
      "Contract-2026.pdf",
    ]);
    await store.close();
  });

  it("matches names by the file's own name while the search index is still filling", async () => {
    const store = await filesMailbox({ indexed: false });

    expect(await names(store, { name: "invoice" })).toEqual([
      "invoice-march.pdf",
    ]);
    await store.close();
  });
});

// A reply chain that re-attaches the same file, listed oldest first.
const REPLY_CHAIN: Seed[] = [
  {
    id: "other-thread",
    conversation: "other",
    from: "Cy <cy@example.com>",
    attachments: [file("Plan.pdf", "application/pdf")],
  },
  {
    id: "first",
    conversation: "plan",
    from: "Ana Lima <ana@example.com>",
    subject: "Plan",
    attachments: [
      file("Plan.pdf", "application/pdf"),
      file("Draft.docx", "application/msword", false, 500),
    ],
  },
  {
    id: "reply",
    conversation: "plan",
    from: "Ben <ben@example.com>",
    subject: "Re: Plan",
    attachments: [
      file("Plan.pdf", "application/pdf"),
      file("Draft.docx", "application/msword", false, 900),
    ],
  },
  {
    id: "last",
    conversation: "plan",
    from: "Ana Lima <ana@example.com>",
    subject: "Re: Re: Plan",
    attachments: [
      file("Plan.pdf", "application/pdf"),
      file("Plan.pdf", "application/pdf"),
    ],
  },
];

describe("the same file in one conversation", () => {
  it("lists it once from the newest message, with how many messages carry it", async () => {
    const store = await filesMailbox({ mailbox: REPLY_CHAIN });

    const page = await store.readFiles(query());
    expect(
      page.files.map((entry) => [
        entry.messageId,
        entry.attachment.filename,
        entry.attachment.size,
        entry.copies,
      ]),
    ).toEqual([
      ["last", "Plan.pdf", 1024, 3],
      ["reply", "Draft.docx", 900, 1],
      ["first", "Draft.docx", 500, 1],
      ["other-thread", "Plan.pdf", 1024, 1],
    ]);
    await store.close();
  });

  it("dedupes among the files that pass the filters", async () => {
    const store = await filesMailbox({ mailbox: REPLY_CHAIN });

    const fromBen = await store.readFiles(query({ sender: "ben@example.com" }));
    expect(
      fromBen.files.map((entry) => [entry.messageId, entry.copies]),
    ).toEqual([
      ["reply", 1],
      ["reply", 1],
    ]);
    const fromAna = await store.readFiles(query({ sender: "ana@example.com" }));
    expect(
      fromAna.files.map((entry) => [
        entry.messageId,
        entry.attachment.filename,
        entry.copies,
      ]),
    ).toEqual([
      ["last", "Plan.pdf", 2],
      ["first", "Draft.docx", 1],
    ]);
    expect(await names(store, { name: "draft" })).toEqual([
      "Draft.docx",
      "Draft.docx",
    ]);
    await store.close();
  });

  it("pages without repeating or skipping a file, whatever the page size", async () => {
    const store = await filesMailbox({ mailbox: REPLY_CHAIN });

    for (const pageSize of [1, 2, 3]) {
      const seen: string[] = [];
      let after: string | null = null;
      do {
        const page = await store.readFiles(query({ pageSize, after }));
        seen.push(
          ...page.files.map(
            (entry) => `${entry.messageId}:${entry.attachment.filename}`,
          ),
        );
        after = page.nextPage;
      } while (after);
      expect(seen).toEqual([
        "last:Plan.pdf",
        "reply:Draft.docx",
        "first:Draft.docx",
        "other-thread:Plan.pdf",
      ]);
    }
    await store.close();
  });
});

// Past this many messages a conversation's copies are no longer all counted.
const CONVERSATION_COPY_CAP = 500;

describe("a conversation longer than the lookup cap", () => {
  it("lists the newest copy once and still lists files only its oldest messages hold", async () => {
    const total = CONVERSATION_COPY_CAP + 20;
    const mailbox: Seed[] = Array.from({ length: total }, (_, index) => ({
      id: `m${String(index).padStart(4, "0")}`,
      conversation: "long",
      attachments: [
        file("Same.pdf", "application/pdf"),
        ...(index === 0 ? [file("Oldest.pdf", "application/pdf")] : []),
      ],
    }));
    const store = await filesMailbox({ mailbox });

    const seen: string[] = [];
    let after: string | null = null;
    do {
      const page = await store.readFiles(query({ pageSize: 1, after }));
      seen.push(
        ...page.files.map(
          (entry) =>
            `${entry.messageId}:${entry.attachment.filename}:${entry.copies}`,
        ),
      );
      after = page.nextPage;
    } while (after);
    // The count is left at 1 once copies may be uncounted, so the note never
    // states a wrong number.
    expect(seen).toEqual([
      `m${String(total - 1).padStart(4, "0")}:Same.pdf:1`,
      "m0000:Oldest.pdf:1",
    ]);
    await store.close();
  });
});

// Names and addresses in other scripts fold case the way the search index
// does, not only in ASCII.
const MULTILINGUAL: Seed[] = [
  {
    id: "report",
    from: "Ирина <Irina@Пример.рф>",
    subject: "Отчет",
    attachments: [
      file("Отчет за март.pdf", "application/pdf"),
      file("Прочее.txt", "text/plain"),
    ],
  },
  {
    id: "overview",
    from: "Jürgen <JÜRGEN@bücher.de>",
    subject: "Übersicht",
    attachments: [
      file("ÜBERSICHT Ärzte.docx", "application/msword"),
      file("Anhang.pdf", "application/pdf"),
    ],
  },
];

describe("names and senders in any script", () => {
  for (const indexed of [true, false])
    it(`matches capitalized Cyrillic and German names ${indexed ? "through the index" : "before indexing"}`, async () => {
      const store = await filesMailbox({ indexed, mailbox: MULTILINGUAL });

      expect(await names(store, { name: "отчет" })).toEqual([
        "Отчет за март.pdf",
      ]);
      expect(await names(store, { name: "übersicht" })).toEqual([
        "ÜBERSICHT Ärzte.docx",
      ]);
      expect(await names(store, { name: "ärzte" })).toEqual([
        "ÜBERSICHT Ärzte.docx",
      ]);
      await store.close();
    });

  it("filters by a sender address whatever its case, in any script", async () => {
    const store = await filesMailbox({ mailbox: MULTILINGUAL });

    expect(await names(store, { sender: "jürgen@bücher.de" })).toEqual([
      "ÜBERSICHT Ärzte.docx",
      "Anhang.pdf",
    ]);
    expect(await names(store, { sender: "irina@пример.рф" })).toEqual([
      "Отчет за март.pdf",
      "Прочее.txt",
    ]);
    await store.close();
  });

  it("matches a sender stored in decomposed form, as the sender list offers it", async () => {
    const decomposed = "Jose\u0301 <JOSE\u0301@example.com>";
    const store = await filesMailbox({
      mailbox: [
        {
          id: "nfd",
          from: decomposed,
          attachments: [file("plan.pdf", "application/pdf")],
        },
      ],
    });

    const [offered] = await store.readFileSenders(["acc-1"]);
    expect(offered.email).toBe("jos\u00e9@example.com");
    expect(await names(store, { sender: offered.email })).toEqual(["plan.pdf"]);
    expect(await names(store, { sender: "JOSE\u0301@example.com" })).toEqual([
      "plan.pdf",
    ]);
    await store.close();
  });

  it("pages a filtered list without repeating or skipping files", async () => {
    const store = await filesMailbox({ indexed: false });

    const all: string[] = [];
    let after: string | null = null;
    do {
      const page = await store.readFiles(
        query({ kind: "pdf", pageSize: 1, after }),
      );
      all.push(...page.files.map((entry) => entry.attachment.filename));
      after = page.nextPage;
    } while (after);
    expect(all).toEqual([
      "invoice-march.pdf",
      "terms.pdf",
      "Contract-2026.pdf",
    ]);
    await store.close();
  });
});

describe("files index migration", () => {
  it("adds the files index to a mailbox opened before it existed", async () => {
    const driver = createNodeSqliteDriver();
    await createSqliteMailStore(driver);
    await driver.write((tx) =>
      tx.exec(
        "DROP INDEX effective_files_order; DELETE FROM schema_migrations WHERE id = 15;",
      ),
    );

    const store = await createSqliteMailStore(driver);
    const index = await driver.read((tx) =>
      tx.query(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'effective_files_order'",
      ),
    );
    expect(index).toHaveLength(1);
    await store.close();
  });
});

describe("readFileSenders", () => {
  it("counts each address's files once under its most used name", async () => {
    const store = await filesMailbox();

    expect(await store.readFileSenders(["acc-1", "acc-2"])).toEqual([
      { email: "ana@example.com", name: "Ana Lima", files: 4 },
      { email: "ben@example.com", name: "Ben", files: 3 },
      { email: "billing@acme.example", name: "Billing", files: 2 },
    ]);
    await store.close();
  });
});

describe("readFilesNotOnDevice", () => {
  const mailbox: Seed[] = [
    ...MAILBOX,
    { id: "old-1", attachments: [], bodyless: true },
    { id: "old-2", attachments: [], bodyless: true },
    { id: "old-trash", roles: ["trash"], attachments: [], bodyless: true },
    { id: "old-draft", roles: ["draft"], attachments: [], bodyless: true },
    { id: "old-work", account: "acc-2", attachments: [], bodyless: true },
  ];

  it("counts listed messages with attachments whose body isn't stored, leaving out what Files never lists", async () => {
    const store = await filesMailbox({ mailbox });

    expect(await store.readFilesNotOnDevice(["acc-1"])).toBe(2);
    expect(await store.readFilesNotOnDevice(["acc-1", "acc-2"])).toBe(3);
    await store.close();
  });

  it("is zero once every body is stored", async () => {
    const store = await filesMailbox();

    expect(await store.readFilesNotOnDevice(["acc-1", "acc-2"])).toBe(0);
    expect(await store.readFilesNotOnDevice([])).toBe(0);
    await store.close();
  });
});

async function names(store: MailStore, filters: Partial<FilesQuery>) {
  const page = await store.readFiles(query(filters));
  return page.files.map((entry) => entry.attachment.filename);
}

function query(overrides: Partial<FilesQuery> = {}): FilesQuery {
  return {
    accountIds: ["acc-1"],
    kind: null,
    sender: null,
    name: null,
    pageSize: 50,
    after: null,
    ...overrides,
  };
}

async function filesMailbox({
  indexed = true,
  mailbox = MAILBOX,
}: {
  indexed?: boolean;
  mailbox?: Seed[];
} = {}) {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  for (const accountId of ["acc-1", "acc-2"]) {
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g1",
    });
    const seeds = mailbox.filter(
      (seed) => (seed.account ?? "acc-1") === accountId,
    );
    await store.applySyncPage({
      ownerId: "owner",
      page: {
        session: { accountId, generation: "g1" },
        requestId: `bootstrap-${accountId}`,
        from: { streamId: "primary", generation: "g1", checkpoint: null },
        to: { streamId: "primary", generation: "g1", checkpoint: "1" },
        changes: seeds.map((seed) =>
          messagePatch(accountId, seed, mailbox.indexOf(seed)),
        ),
        requiredHydration: [],
        roundComplete: true,
      },
      bodies: seeds
        .filter((seed) => !seed.bodyless)
        .map((seed) => ({
          key: { accountId, messageId: seed.id },
          version: "1",
          text: "See attached",
          html: null,
          attachments: seed.attachments,
        })),
    });
  }
  if (indexed)
    while ((await store.indexSearchBacklog()).remaining) {
      // keep indexing
    }
  else await driver.write(clearSearchIndex);
  return store;
}

function messagePatch(
  accountId: string,
  seed: Seed,
  index: number,
): Extract<ProviderChange, { kind: "message_patch" }> {
  const roles = seed.roles ?? ["inbox"];
  return {
    kind: "message_patch",
    key: { accountId, messageId: seed.id },
    reference: {
      provider: "google",
      messageId: seed.id,
      conversationId: seed.conversation ?? seed.id,
      version: "1",
    },
    fields: {
      subject: seed.subject ?? seed.id,
      preview: "",
      from: seed.from ?? "someone@example.com",
      to: ["me@example.com"],
      cc: [],
      receivedAtMs: 1000 + index,
      read: true,
      starred: false,
      folderId: null,
      labelIds: roles.map((role) => role.toUpperCase()),
      categoryIds: [],
      roles,
      hasAttachments: true,
    },
  };
}

function file(
  filename: string,
  mimeType: string,
  inline = false,
  size = 1024,
): MessageAttachmentDescriptor {
  return {
    attachmentId: `att-${filename}`,
    filename,
    mimeType,
    size,
    inline,
  };
}
