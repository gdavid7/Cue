import type {
  LeftOpenDraft,
  LeftOpenDraftsQuery,
} from "@inboxzero/mail-core/queries";
import type { SqlTransaction } from "./driver";
import { LOCAL_MIGRATIONS } from "./local-migrations";

// SQLite only uses a partial index for a query that repeats its WHERE clause,
// so the index and the read share this one.
const MAILBOX_DRAFTS = "in_draft = 1 AND in_trash = 0 AND in_spam = 0";

// Each conversation by its newest draft, which counts only once it is older
// than the cutoff and has a body. Whitespace alone, including a non-breaking
// space, is no body. Grouping by conversation would otherwise lead SQLite to
// the conversation index, which walks every message in the account.
const DRAFTS_SQL = `SELECT message_id, conversation_id, subject, to_json, received_at_ms
FROM (
  SELECT message_id, conversation_id, subject, preview, to_json, received_at_ms,
    ROW_NUMBER() OVER (
      PARTITION BY conversation_id
      ORDER BY received_at_ms DESC, message_id DESC
    ) AS newest
  FROM effective_messages INDEXED BY effective_drafts_order
  WHERE account_id = ? AND ${MAILBOX_DRAFTS}
)
WHERE newest = 1
  AND received_at_ms < ?
  AND trim(preview, ' ' || char(9, 10, 13, 160)) <> ''
ORDER BY received_at_ms DESC
LIMIT ?`;

/**
 * Today reads an account's drafts on every visit, so a partial index over
 * only its drafts keeps that read small on a large mailbox.
 */
export async function migrateLeftOpenDraftsIndex(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.leftOpenDraftsIndex.id],
  );
  if (applied.length) return;
  await tx.exec(`
    CREATE INDEX IF NOT EXISTS effective_drafts_order
      ON effective_messages(account_id, received_at_ms DESC)
      WHERE ${MAILBOX_DRAFTS};
  `);
  await tx.execute("INSERT INTO schema_migrations(id, name) VALUES (?, ?)", [
    LOCAL_MIGRATIONS.leftOpenDraftsIndex.id,
    LOCAL_MIGRATIONS.leftOpenDraftsIndex.name,
  ]);
}

/**
 * Drafts the user started and left, by what the mailbox holds. Cue's reply
 * suggestions stay in Cue until the user edits one, which only then becomes
 * a mailbox draft, so they aren't here. A sent draft has left the mailbox's
 * drafts. Each conversation is judged by its newest draft, which is skipped
 * while it is still being written or holds no body.
 */
export async function readLeftOpenDrafts(
  tx: SqlTransaction,
  input: LeftOpenDraftsQuery,
): Promise<LeftOpenDraft[]> {
  const limit = Math.max(input.limit, 0);
  if (limit === 0) return [];
  const drafts: LeftOpenDraft[] = [];
  for (const accountId of new Set(input.accountIds)) {
    const rows = await tx.query(DRAFTS_SQL, [
      accountId,
      input.savedBeforeMs,
      limit,
    ]);
    for (const row of rows)
      drafts.push({
        accountId,
        conversationId: String(row.conversation_id),
        messageId: String(row.message_id),
        subject: String(row.subject),
        to: parseAddresses(row.to_json),
        savedAtMs: Number(row.received_at_ms),
      });
  }
  return drafts.sort((a, b) => b.savedAtMs - a.savedAtMs).slice(0, limit);
}

function parseAddresses(json: unknown): string[] {
  try {
    const parsed: unknown = JSON.parse(String(json));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}
