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
import { attachmentNameForms, searchMatchQuery } from "./search-text";

const MIGRATION_ID = 15;
const SENDER_LIMIT = 500;

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
    [MIGRATION_ID],
  );
  if (applied.length) return;
  await tx.exec(`
    CREATE INDEX IF NOT EXISTS effective_files_order
      ON effective_messages(received_at_ms DESC, account_id, message_id)
      WHERE ${FILE_MESSAGES.replaceAll("e.", "")};
  `);
  await tx.execute(
    "INSERT INTO schema_migrations(id, name) VALUES (?, '0015-files-order-index')",
    [MIGRATION_ID],
  );
}

/**
 * One page of every real attachment on stored mail. A message's files come
 * from the details stored with its body, so mail whose body was never
 * downloaded lists its files once it is.
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
  where.push("json_extract(a.value, '$.inline') = 0");
  if (query.kind) {
    where.push(`${fileKindSql("a")} = ?`);
    bindings.push(query.kind);
  }
  if (query.sender) {
    const sender = query.sender.trim().toLowerCase();
    where.push(
      `(LOWER(e.from_address) = ? OR LOWER(e.from_address) LIKE ? ESCAPE '\\')`,
    );
    bindings.push(sender, `%<${escapeLike(sender)}>`);
  }
  const name = query.name?.trim();
  if (name) {
    const clause = nameClause(name, search);
    if (!clause) return { files: [], nextPage: null };
    where.push(clause.sql);
    bindings.push(...clause.bindings);
  }
  const cursor = query.after ? parseCursor(query.after) : null;
  if (cursor) {
    where.push(
      "(e.received_at_ms < ? OR (e.received_at_ms = ? AND (e.account_id, e.message_id, a.key) > (?, ?, ?)))",
    );
    bindings.push(
      cursor.receivedAtMs,
      cursor.receivedAtMs,
      cursor.accountId,
      cursor.messageId,
      cursor.position,
    );
  }
  const rows = await tx.query(
    `SELECT e.account_id, e.message_id, e.conversation_id, e.subject,
            e.from_address, e.received_at_ms, a.key AS position,
            a.value AS attachment, ${fileKindSql("a")} AS kind
     FROM effective_messages e
     CROSS JOIN message_content c
       ON c.account_id = e.account_id AND c.message_id = e.message_id
     CROSS JOIN json_each(c.attachments_json) a
     WHERE ${where.join(" AND ")}
     ORDER BY e.received_at_ms DESC, e.account_id, e.message_id, a.key
     LIMIT ?`,
    [...bindings, query.pageSize + 1],
  );
  const listed = rows.slice(0, query.pageSize);
  const last = listed.at(-1);
  return {
    files: listed.flatMap(toFileEntry),
    nextPage:
      rows.length > query.pageSize && last
        ? JSON.stringify([
            Number(last.received_at_ms),
            String(last.account_id),
            String(last.message_id),
            Number(last.position),
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
export const FILE_KIND_RULES: ReadonlyArray<{
  kind: Exclude<FileKind, "other">;
  types: readonly string[];
  extensions: readonly string[];
}> = [
  { kind: "pdf", types: ["application/pdf"], extensions: ["pdf"] },
  {
    kind: "spreadsheet",
    types: [
      "%spreadsheet%",
      "%ms-excel%",
      "text/csv",
      "text/tab-separated-values",
      "application/vnd.apple.numbers",
    ],
    extensions: ["xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods", "numbers"],
  },
  {
    kind: "presentation",
    types: [
      "%presentation%",
      "%ms-powerpoint%",
      "application/vnd.apple.keynote",
    ],
    extensions: ["ppt", "pptx", "pps", "ppsx", "odp", "key"],
  },
  {
    kind: "document",
    types: [
      "%wordprocessing%",
      "%msword%",
      "%opendocument.text%",
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
    types: ["image/%"],
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

/** The kind of the attachment in json_each row `alias`, as SQL. */
function fileKindSql(alias: string) {
  const type = `LOWER(json_extract(${alias}.value, '$.mimeType'))`;
  const name = `json_extract(${alias}.value, '$.filename')`;
  const cases = FILE_KIND_RULES.map(({ kind, types, extensions }) => {
    const tests = [
      ...types.map((pattern) => `${type} LIKE '${pattern}'`),
      ...extensions.map((extension) => `${name} LIKE '%.${extension}'`),
    ];
    return `WHEN ${tests.join(" OR ")} THEN '${kind}'`;
  });
  return `(CASE ${cases.join(" ")} ELSE 'other' END)`;
}

// A file matches a name search when its message matches it in the search
// index, as local search finds attachments, and the file's own name holds
// the words. When none of a matching message's files hold them as written
// (the index also folds accents), all its files stay listed rather than
// none. Mail not indexed yet is matched by the file's name alone.
function nameClause(
  name: string,
  search: SearchSupport,
): { sql: string; bindings: SqlValue[] } | null {
  const forms = attachmentNameForms(name);
  if (!forms.length) return null;
  const named = (alias: string) => ({
    sql: forms
      .map(
        (group) =>
          `(${group
            .map(
              () =>
                `LOWER(json_extract(${alias}.value, '$.filename')) LIKE ? ESCAPE '\\'`,
            )
            .join(" OR ")})`,
      )
      .join(" AND "),
    bindings: forms.flatMap((group) =>
      group.map((form) => `%${escapeLike(form)}%`),
    ),
  });
  const own = named("a");
  if (!search.fts5) return own;
  const match = searchMatchQuery(name, "term");
  if (!match) return null;
  const sibling = named("b");
  const indexed = {
    sql: `((e.account_id, e.message_id) IN (
        SELECT k.account_id, k.message_id FROM message_fts_keys k
        WHERE k.fts_rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)
      ) AND (${own.sql} OR NOT EXISTS (
        SELECT 1 FROM json_each(c.attachments_json) b
        WHERE json_extract(b.value, '$.inline') = 0 AND ${sibling.sql}
      )))`,
    bindings: [
      `attachments : (${match})`,
      ...own.bindings,
      ...sibling.bindings,
    ],
  };
  if (search.complete) return indexed;
  return {
    sql: `(${indexed.sql} OR (NOT EXISTS (
        SELECT 1 FROM message_fts_keys k
        WHERE k.account_id = e.account_id AND k.message_id = e.message_id
      ) AND ${own.sql}))`,
    bindings: [...indexed.bindings, ...own.bindings],
  };
}

function toFileEntry(row: Record<string, SqlValue>): FileEntry[] {
  let value: unknown;
  try {
    value = JSON.parse(String(row.attachment));
  } catch {
    return [];
  }
  const attachment = messageAttachmentDescriptorSchema.safeParse(value);
  if (!attachment.success) return [];
  return [
    {
      accountId: String(row.account_id),
      conversationId: String(row.conversation_id),
      messageId: String(row.message_id),
      subject: String(row.subject),
      from: String(row.from_address),
      receivedAtMs: Number(row.received_at_ms),
      kind: String(row.kind) as FileKind,
      attachment: attachment.data,
    },
  ];
}

function parseCursor(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 4) return null;
    const [receivedAtMs, accountId, messageId, position] = parsed;
    if (
      typeof receivedAtMs !== "number" ||
      typeof accountId !== "string" ||
      typeof messageId !== "string" ||
      typeof position !== "number"
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
