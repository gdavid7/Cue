import type {
  EmbeddingBacklogCursor,
  EmbeddingCap,
  EmbeddingSource,
  MessageEmbedding,
} from "@inboxzero/mail-core/ports/mail-store";
import type { SemanticMatch } from "@inboxzero/mail-core/queries";
import type { SqlTransaction, SqlValue } from "./driver";
import { decodeMessageBody, type MessageBodyCodec } from "./message-body-codec";
import { htmlToSearchText } from "./search-text";

// Vectors of recent mail for semantic search, made on this device by the
// page's embedding model. Each is a unit vector as signed bytes, so brute
// force over a capped set stays a few milliseconds: no vector index needed.
const MESSAGE_EMBEDDINGS_SQL = `
CREATE TABLE IF NOT EXISTS message_embeddings (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  model TEXT NOT NULL,
  received_at_ms INTEGER NOT NULL,
  from_body INTEGER NOT NULL CHECK (from_body IN (0, 1)),
  vector BLOB NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE INDEX IF NOT EXISTS message_embeddings_model
  ON message_embeddings(model, account_id);
-- The backlog and the cap walk mail newest first across accounts, a few
-- rows per batch, without reading the table or sorting.
CREATE INDEX IF NOT EXISTS effective_messages_received
  ON effective_messages(received_at_ms, account_id, message_id, in_spam, in_trash, in_draft);
`;

/**
 * The keys of the next backlog batch: walks the received index down from
 * the cursor and stops at the limit, reading no bodies.
 */
export const EMBEDDING_BACKLOG_KEYS_SQL = `
SELECT m.account_id, m.message_id, m.received_at_ms
FROM effective_messages m INDEXED BY effective_messages_received
LEFT JOIN message_embeddings e
  ON e.account_id = m.account_id AND e.message_id = m.message_id
WHERE m.received_at_ms >= ?
  AND (m.received_at_ms, m.account_id, m.message_id) < (?, ?, ?)
  AND m.in_spam = 0 AND m.in_trash = 0 AND m.in_draft = 0
  AND (
    e.message_id IS NULL
    OR e.model != ?
    OR (e.from_body = 0 AND EXISTS (
      SELECT 1 FROM message_content c
      WHERE c.account_id = m.account_id AND c.message_id = m.message_id
    ))
  )
ORDER BY m.received_at_ms DESC, m.account_id DESC, m.message_id DESC
LIMIT ?`;

/** Where the cap starts: the received time of the `maxMessages`th newest. */
export const EMBEDDING_CAP_START_SQL = `
SELECT received_at_ms FROM effective_messages INDEXED BY effective_messages_received
WHERE received_at_ms >= ?
  AND in_spam = 0 AND in_trash = 0 AND in_draft = 0
ORDER BY received_at_ms DESC, account_id DESC, message_id DESC
LIMIT 1 OFFSET ?`;

// Enough of a body to say what the mail is about; the model reads less.
const BODY_CHARS = 1200;

export async function migrateMessageEmbeddings(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = 12",
  );
  if (applied.length) return;
  await tx.exec(MESSAGE_EMBEDDINGS_SQL);
  await tx.execute(
    "INSERT INTO schema_migrations(id, name) VALUES (12, '0012-message-embeddings')",
  );
}

/**
 * The next messages received since `sinceMs`, older than `before`, that
 * `model` has no vector for, or only one made from the preview while the
 * body is now stored. Mail in spam, trash or drafts is left out: search
 * ranks it last anyway. Bodies are read for this batch alone.
 */
export async function readEmbeddingBacklog(
  tx: SqlTransaction,
  codec: MessageBodyCodec,
  input: {
    model: string;
    sinceMs: number;
    limit: number;
    before: EmbeddingBacklogCursor | null;
  },
): Promise<EmbeddingSource[]> {
  const keys = await tx.query(EMBEDDING_BACKLOG_KEYS_SQL, [
    input.sinceMs,
    input.before?.receivedAtMs ?? Number.MAX_SAFE_INTEGER,
    input.before?.key.accountId ?? "",
    input.before?.key.messageId ?? "",
    input.model,
    input.limit,
  ]);
  const sources: EmbeddingSource[] = [];
  for (const key of keys) {
    const [row] = await tx.query(
      `SELECT m.subject, m.preview, m.from_address,
              c.text, c.html, c.message_id AS content_id
       FROM effective_messages m
       LEFT JOIN message_content c
         ON c.account_id = m.account_id AND c.message_id = m.message_id
       WHERE m.account_id = ? AND m.message_id = ?`,
      [key.account_id, key.message_id],
    );
    if (!row) continue;
    // A body that can't be read is embedded from its preview.
    const body = row.content_id
      ? await readBodyText(codec, row.text, row.html).catch(() => "")
      : "";
    sources.push({
      key: {
        accountId: String(key.account_id),
        messageId: String(key.message_id),
      },
      receivedAtMs: Number(key.received_at_ms),
      subject: String(row.subject ?? ""),
      from: String(row.from_address ?? ""),
      body: body || String(row.preview ?? ""),
      // Set by the stored body, even an empty one, so a message whose body
      // has no text isn't offered again on every pass.
      fromBody: Boolean(row.content_id),
    });
  }
  return sources;
}

export async function writeMessageEmbeddings(
  tx: SqlTransaction,
  input: { model: string; embeddings: MessageEmbedding[] },
) {
  for (const embedding of input.embeddings) {
    // Only for mail still here, so a purge between reading and writing a
    // batch leaves no vector behind.
    await tx.execute(
      `INSERT INTO message_embeddings(account_id, message_id, model, received_at_ms, from_body, vector)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM effective_messages
         WHERE account_id = ? AND message_id = ?
       )
       ON CONFLICT(account_id, message_id) DO UPDATE SET
         model = excluded.model,
         received_at_ms = excluded.received_at_ms,
         from_body = excluded.from_body,
         vector = excluded.vector`,
      [
        embedding.key.accountId,
        embedding.key.messageId,
        input.model,
        embedding.receivedAtMs,
        embedding.fromBody ? 1 : 0,
        new Uint8Array(
          embedding.vector.buffer,
          embedding.vector.byteOffset,
          embedding.vector.byteLength,
        ),
        embedding.key.accountId,
        embedding.key.messageId,
      ],
    );
  }
}

/**
 * Drops vectors outside the cap, from another model, or of messages no
 * longer in the mailbox. Resolves how many it dropped, and where the cap
 * starts, which a pass reads once.
 */
export async function pruneMessageEmbeddings(
  tx: SqlTransaction,
  input: EmbeddingCap,
): Promise<{ dropped: number; sinceMs: number }> {
  const sinceMs = await capStartMs(tx, input);
  const { changedRows } = await tx.execute(
    `DELETE FROM message_embeddings
     WHERE model != ?
        OR received_at_ms < ?
        OR NOT EXISTS (
          SELECT 1 FROM effective_messages m
          WHERE m.account_id = message_embeddings.account_id
            AND m.message_id = message_embeddings.message_id
            AND m.in_spam = 0 AND m.in_trash = 0 AND m.in_draft = 0
        )`,
    [input.model, sinceMs],
  );
  return { dropped: changedRows, sinceMs };
}

export async function countMessageEmbeddings(
  tx: SqlTransaction,
  input: { accountId: string; model: string },
) {
  const [row] = await tx.query(
    "SELECT COUNT(*) AS n FROM message_embeddings WHERE account_id = ? AND model = ?",
    [input.accountId, input.model],
  );
  return Number(row?.n ?? 0);
}

/**
 * The account's messages most similar to `vector`, best first, at most one
 * per conversation. A brute-force scan: the cap keeps it to a few thousand
 * 384-byte rows.
 */
export async function readSemanticMatches(
  tx: SqlTransaction,
  input: {
    accountId: string;
    model: string;
    vector: Int8Array;
    limit: number;
    minSimilarity: number;
  },
): Promise<SemanticMatch[]> {
  const rows = await tx.query(
    `SELECT e.message_id, m.conversation_id, e.vector
     FROM message_embeddings e
     JOIN effective_messages m
       ON m.account_id = e.account_id AND m.message_id = e.message_id
     WHERE e.account_id = ? AND e.model = ?`,
    [input.accountId, input.model],
  );
  const scale = 127 * 127;
  const best = new Map<string, SemanticMatch>();
  for (const row of rows) {
    if (!(row.vector instanceof Uint8Array)) continue;
    const stored = new Int8Array(
      row.vector.buffer,
      row.vector.byteOffset,
      row.vector.byteLength,
    );
    if (stored.length !== input.vector.length) continue;
    let dot = 0;
    for (let index = 0; index < stored.length; index += 1)
      dot += stored[index] * input.vector[index];
    const similarity = dot / scale;
    if (similarity < input.minSimilarity) continue;
    const conversationId = String(row.conversation_id);
    const current = best.get(conversationId);
    if (!current || similarity > current.similarity) {
      best.set(conversationId, {
        messageId: String(row.message_id),
        conversationId,
        similarity,
      });
    }
  }
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, input.limit);
}

export async function deleteAccountMessageEmbeddings(
  tx: SqlTransaction,
  accountId: string,
) {
  await tx.execute("DELETE FROM message_embeddings WHERE account_id = ?", [
    accountId,
  ]);
}

/**
 * Where the cap starts: `sinceMs`, or later when more than `maxMessages`
 * messages are newer than it.
 */
async function capStartMs(
  tx: SqlTransaction,
  input: { sinceMs: number; maxMessages: number },
) {
  const [row] = await tx.query(EMBEDDING_CAP_START_SQL, [
    input.sinceMs,
    input.maxMessages - 1,
  ]);
  return row
    ? Math.max(input.sinceMs, Number(row.received_at_ms))
    : input.sinceMs;
}

async function readBodyText(
  codec: MessageBodyCodec,
  text: SqlValue,
  html: SqlValue,
) {
  const plain = await decodeMessageBody(codec, text);
  if (plain?.trim()) return clip(plain);
  const markup = await decodeMessageBody(codec, html);
  return markup ? clip(htmlToSearchText(markup)) : "";
}

function clip(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, BODY_CHARS);
}
