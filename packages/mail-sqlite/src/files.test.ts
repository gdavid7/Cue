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
  account?: string;
  from?: string;
  subject?: string;
  roles?: ("inbox" | "trash" | "spam" | "draft" | "sent")[];
  attachments: MessageAttachmentDescriptor[];
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

describe("files index migration", () => {
  it("adds the files index to a mailbox opened before it existed", async () => {
    const driver = createNodeSqliteDriver();
    await createSqliteMailStore(driver);
    await driver.write((tx) =>
      tx.exec(
        "DROP INDEX effective_files_order; DELETE FROM schema_migrations WHERE id = 13;",
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

async function filesMailbox({ indexed = true } = {}) {
  const driver = createNodeSqliteDriver();
  const store = await createSqliteMailStore(driver);
  for (const accountId of ["acc-1", "acc-2"]) {
    await store.ensureAccount({
      accountId,
      provider: "google",
      generation: "g1",
    });
    const seeds = MAILBOX.filter(
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
          messagePatch(accountId, seed, MAILBOX.indexOf(seed)),
        ),
        requiredHydration: [],
        roundComplete: true,
      },
      bodies: seeds.map((seed) => ({
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
      conversationId: seed.id,
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
): MessageAttachmentDescriptor {
  return {
    attachmentId: `att-${filename}`,
    filename,
    mimeType,
    size: 1024,
    inline,
  };
}
