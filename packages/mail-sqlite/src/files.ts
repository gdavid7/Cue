import { LOCAL_MIGRATIONS } from "./local-migrations";
import { messageAttachmentDescriptorSchema } from "@inboxzero/mail-core/messages";
import type {
  FileEntry,
  FileKind,
  FileSender,
  FilesPage,
  FilesQuery,
} from "@inboxzero/mail-core/queries";
import { parseAddress } from "./contact-suggestions";
import type { SqlTransaction, SqlValue } from "./driver";
import type { SearchSupport } from "./queries";
import {
  attachmentNameForms,
  foldForMatch,
  searchMatchQuery,
} from "./search-text";

// The sender filter offers the people who sent the most files; past this many
// the rest are left out, which keeps the typeahead's list small to send and
// search on every keystroke.
const SENDER_LIMIT = 500;
// A narrow filter can skip most messages, so each read looks at a few more.
const MIN_BATCH_MESSAGES = 100;
// A filter that matches little would otherwise read every message with files
// in one transaction. Past this many, a page comes back short (even empty)
// with a cursor after the last message read, and the next page goes on.
const MAX_SCANNED_MESSAGES = 2000;

// The mail the Files view lists files from. SQLite only uses a partial index
// for a query that repeats its WHERE clause, so the index and the reads share
// this one.
const FILE_MESSAGES =
  "e.has_attachments = 1 AND e.in_trash = 0 AND e.in_spam = 0 AND e.in_draft = 0";

/**
 * The Files view walks mail with attachments newest first and stops once a
 * page is full, so a partial index over only that mail keeps the first page
 * as quick on a large mailbox as on a small one.
 */
export async function migrateFilesIndex(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.filesOrderIndex.id],
  );
  if (applied.length) return;
  await tx.exec(`
    CREATE INDEX IF NOT EXISTS effective_files_order
      ON effective_messages(received_at_ms DESC, account_id, message_id)
      WHERE ${FILE_MESSAGES.replaceAll("e.", "")};
  `);
  await tx.execute("INSERT INTO schema_migrations(id, name) VALUES (?, ?)", [
    LOCAL_MIGRATIONS.filesOrderIndex.id,
    LOCAL_MIGRATIONS.filesOrderIndex.name,
  ]);
}

/**
 * One page of every real attachment on stored mail. A message's files come
 * from the details stored with its body, so mail whose body was never
 * downloaded lists its files once it is.
 *
 * SQLite reads candidate messages newest first through the files index, and
 * each file is then checked here: SQLite's LOWER and LIKE fold case in ASCII
 * only, and names and addresses come in every script. Messages are read in
 * batches until the page is full or MAX_SCANNED_MESSAGES have been read, so
 * a page can be short, even empty, and still have a next page.
 */
export async function readFiles(
  tx: SqlTransaction,
  query: FilesQuery,
  search: SearchSupport,
): Promise<FilesPage> {
  const accountIds = [...new Set(query.accountIds)];
  if (!accountIds.length || query.pageSize < 1)
    return { files: [], nextPage: null };
  // The unary + keeps SQLite from starting at each account's primary key and
  // sorting all its mail; it walks the files index newest first instead.
  const where = [
    FILE_MESSAGES,
    `+e.account_id IN (${placeholders(accountIds)})`,
  ];
  const bindings: SqlValue[] = [...accountIds];
  const sender = query.sender ? foldAddress(query.sender) : null;
  // Only an ASCII address can be narrowed by LIKE without missing a match.
  if (sender && /^[\x20-\x7e]+$/.test(sender)) {
    where.push(`e.from_address LIKE ? ESCAPE '\\'`);
    bindings.push(`%${escapeLike(sender)}%`);
  }
  const name = query.name?.trim();
  const nameForms = name ? attachmentNameForms(name) : [];
  let indexedColumn = "1";
  if (name) {
    if (!nameForms.length) return { files: [], nextPage: null };
    const candidates = nameCandidates(name, search);
    if (candidates === null) return { files: [], nextPage: null };
    if (candidates) {
      where.push(candidates.sql);
      bindings.push(...candidates.bindings);
      indexedColumn = candidates.indexed;
    } else indexedColumn = "0";
  }

  const pageCursor = query.after ? parseCursor(query.after) : null;
  // A cursor inside a message starts there; one that read a message through
  // starts after it.
  let after: (FileCursor & { inclusive: boolean }) | null = pageCursor
    ? { ...pageCursor, inclusive: pageCursor.position !== null }
    : null;
  let scanned = 0;
  let scannedThrough: FileCursor | null = null;
  const batchSize = Math.max(query.pageSize, MIN_BATCH_MESSAGES);
  const files: Array<FileEntry & { position: number }> = [];
  while (files.length <= query.pageSize) {
    const cursorSql = after
      ? [
          `(e.received_at_ms < ? OR (e.received_at_ms = ? AND (e.account_id, e.message_id) ${after.inclusive ? ">=" : ">"} (?, ?)))`,
        ]
      : [];
    const rows = await tx.query(
      `SELECT e.account_id, e.message_id, e.conversation_id, e.subject,
              e.from_address, e.received_at_ms, c.attachments_json,
              ${indexedColumn} AS indexed
       FROM effective_messages e
       CROSS JOIN message_content c
         ON c.account_id = e.account_id AND c.message_id = e.message_id
       WHERE ${[...where, ...cursorSql].join(" AND ")}
       ORDER BY e.received_at_ms DESC, e.account_id, e.message_id
       LIMIT ?`,
      [
        ...bindings,
        ...(after
          ? [
              after.receivedAtMs,
              after.receivedAtMs,
              after.accountId,
              after.messageId,
            ]
          : []),
        batchSize,
      ],
    );
    scanned += rows.length;
    for (const row of rows) {
      if (sender && senderOf(row) !== sender) continue;
      const skipThrough =
        pageCursor &&
        pageCursor.position !== null &&
        pageCursor.accountId === String(row.account_id) &&
        pageCursor.messageId === String(row.message_id)
          ? pageCursor.position
          : -1;
      for (const entry of messageFiles(row, query.kind, nameForms)) {
        if (entry.position > skipThrough) files.push(entry);
      }
    }
    const last = rows.at(-1);
    if (rows.length < batchSize || !last) break;
    const through = {
      receivedAtMs: Number(last.received_at_ms),
      accountId: String(last.account_id),
      messageId: String(last.message_id),
      position: null,
    };
    if (files.length <= query.pageSize && scanned >= MAX_SCANNED_MESSAGES) {
      scannedThrough = through;
      break;
    }
    after = { ...through, inclusive: false };
  }
  const page = files.slice(0, query.pageSize);
  const lastFile = page.at(-1);
  let next: FileCursor | null = scannedThrough;
  if (files.length > query.pageSize && lastFile) next = lastFile;
  return {
    files: page.map(({ position: _position, ...entry }) => entry),
    nextPage: next
      ? JSON.stringify([
          next.receivedAtMs,
          next.accountId,
          next.messageId,
          next.position,
        ])
      : null,
  };
}

/**
 * Everyone whose mail the Files view lists, for its sender filter. One
 * address shown with several names counts once, under its most used name.
 */
export async function readFileSenders(
  tx: SqlTransaction,
  accountIds: string[],
): Promise<FileSender[]> {
  const ids = [...new Set(accountIds)];
  if (!ids.length) return [];
  const rows = await tx.query(
    `SELECT e.from_address, COUNT(*) AS files
     FROM effective_messages e
     JOIN message_content c
       ON c.account_id = e.account_id AND c.message_id = e.message_id
     JOIN json_each(c.attachments_json) a
     WHERE ${FILE_MESSAGES} AND e.account_id IN (${placeholders(ids)})
       AND json_extract(a.value, '$.inline') = 0
     GROUP BY e.from_address`,
    ids,
  );
  const senders = new Map<
    string,
    { files: number; names: Map<string, number> }
  >();
  for (const row of rows) {
    const address = parseAddress(String(row.from_address));
    if (!address) continue;
    address.email = foldAddress(address.email);
    const files = Number(row.files);
    const sender = senders.get(address.email) ?? {
      files: 0,
      names: new Map<string, number>(),
    };
    sender.files += files;
    if (address.name)
      sender.names.set(
        address.name,
        (sender.names.get(address.name) ?? 0) + files,
      );
    senders.set(address.email, sender);
  }
  return [...senders.entries()]
    .map(([email, sender]) => ({
      email,
      name:
        [...sender.names.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      files: sender.files,
    }))
    .sort((a, b) => b.files - a.files || a.email.localeCompare(b.email))
    .slice(0, SENDER_LIMIT);
}

/**
 * What kind of file an attachment is, from its type and, since senders often
 * label files `application/octet-stream`, its name. Earlier rules win, so a
 * PDF named `.pdf` is a PDF whatever its type says.
 */
const FILE_KIND_RULES: ReadonlyArray<{
  kind: Exclude<FileKind, "other">;
  types: readonly string[];
  extensions: readonly string[];
}> = [
  { kind: "pdf", types: ["application/pdf"], extensions: ["pdf"] },
  {
    kind: "spreadsheet",
    types: [
      "*spreadsheet*",
      "*ms-excel*",
      "text/csv",
      "text/tab-separated-values",
      "application/vnd.apple.numbers",
    ],
    extensions: ["xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods", "numbers"],
  },
  {
    kind: "presentation",
    types: [
      "*presentation*",
      "*ms-powerpoint*",
      "application/vnd.apple.keynote",
    ],
    extensions: ["ppt", "pptx", "pps", "ppsx", "odp", "key"],
  },
  {
    kind: "document",
    types: [
      "*wordprocessing*",
      "*msword*",
      "*opendocument.text*",
      "application/rtf",
      "text/rtf",
      "text/plain",
      "text/markdown",
      "application/vnd.apple.pages",
    ],
    extensions: [
      "doc",
      "docx",
      "dot",
      "dotx",
      "odt",
      "rtf",
      "txt",
      "md",
      "pages",
    ],
  },
  {
    kind: "image",
    types: ["image/*"],
    extensions: [
      "png",
      "jpg",
      "jpeg",
      "gif",
      "webp",
      "heic",
      "heif",
      "tif",
      "tiff",
      "bmp",
      "svg",
    ],
  },
];

// Messages a name search lists files from: those the search index matches,
// as local search finds attachments, and, until the index is complete, mail
// not indexed yet. Resolves undefined when every message is a candidate
// (no index), and null when nothing in the name can match.
function nameCandidates(
  name: string,
  search: SearchSupport,
): { sql: string; bindings: SqlValue[]; indexed: string } | null | undefined {
  if (!search.fts5) return;
  const match = searchMatchQuery(name, "term");
  if (!match) return null;
  const hit = `(e.account_id, e.message_id) IN (
      SELECT k.account_id, k.message_id FROM message_fts_keys k
      WHERE k.fts_rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)
    )`;
  const bindings = [`attachments : (${match})`];
  if (search.complete) return { sql: hit, bindings, indexed: "1" };
  const indexed = `EXISTS (
      SELECT 1 FROM message_fts_keys k
      WHERE k.account_id = e.account_id AND k.message_id = e.message_id
    )`;
  return { sql: `(${hit} OR NOT ${indexed})`, bindings, indexed };
}

// A message's real files that pass the type and name filters. A file passes
// a name search when its own name holds every word; a message the index
// matched whose files hold none of them as written keeps them all, since the
// index found the words some other way.
function messageFiles(
  row: Record<string, SqlValue>,
  kind: FileKind | null,
  nameForms: string[][],
): Array<FileEntry & { position: number }> {
  const files = storedAttachments(row.attachments_json).filter(
    ({ attachment }) => !attachment.inline,
  );
  let named = files;
  if (nameForms.length) {
    named = files.filter(({ attachment }) =>
      nameHolds(attachment.filename, nameForms),
    );
    if (!named.length && Number(row.indexed) === 1) named = files;
  }
  return named.flatMap(({ attachment, position }) => {
    const fileKind = fileKindOf(attachment);
    if (kind && fileKind !== kind) return [];
    return [
      {
        accountId: String(row.account_id),
        conversationId: String(row.conversation_id),
        messageId: String(row.message_id),
        subject: String(row.subject),
        from: String(row.from_address),
        receivedAtMs: Number(row.received_at_ms),
        kind: fileKind,
        attachment,
        position,
      },
    ];
  });
}

function nameHolds(filename: string, forms: string[][]) {
  const folded = foldForMatch(filename);
  return forms.every((group) => group.some((form) => folded.includes(form)));
}

/** What kind of file an attachment is, by the first rule it meets. */
function fileKindOf(attachment: {
  mimeType: string;
  filename: string;
}): FileKind {
  const type = attachment.mimeType.toLowerCase();
  const name = attachment.filename.toLowerCase();
  const rule = FILE_KIND_RULES.find(
    ({ types, extensions }) =>
      types.some((pattern) => matchesType(type, pattern)) ||
      extensions.some((extension) => name.endsWith(`.${extension}`)),
  );
  return rule?.kind ?? "other";
}

// `*` stands for any run of characters, as in `image/*`.
function matchesType(type: string, pattern: string) {
  const [first, ...rest] = pattern.split("*");
  if (!rest.length) return type === pattern;
  if (!type.startsWith(first)) return false;
  let from = first.length;
  for (const [index, part] of rest.entries()) {
    if (index === rest.length - 1) return type.slice(from).endsWith(part);
    const found = type.indexOf(part, from);
    if (found < 0) return false;
    from = found + part.length;
  }
  return true;
}

function storedAttachments(value: SqlValue | undefined) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(value ?? "[]"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item, position) => {
    const result = messageAttachmentDescriptorSchema.safeParse(item);
    return result.success ? [{ attachment: result.data, position }] : [];
  });
}

// The stored sender's address, compared folded the same way as the filter's.
function senderOf(row: Record<string, SqlValue>) {
  const address = parseAddress(String(row.from_address));
  return address ? foldAddress(address.email) : null;
}

function foldAddress(value: string) {
  return value.trim().normalize("NFC").toLowerCase();
}

type FileCursor = {
  receivedAtMs: number;
  accountId: string;
  messageId: string;
  /** The last file listed in the message, or null once it was read through. */
  position: number | null;
};

function parseCursor(value: string): FileCursor | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [receivedAtMs, accountId, messageId, position] = parsed;
    if (
      typeof receivedAtMs !== "number" ||
      typeof accountId !== "string" ||
      typeof messageId !== "string" ||
      (typeof position !== "number" && position !== null)
    )
      return null;
    return { receivedAtMs, accountId, messageId, position };
  } catch {
    return null;
  }
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(", ");
}

function escapeLike(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
