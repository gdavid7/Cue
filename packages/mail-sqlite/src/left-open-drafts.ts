import type {
  LeftOpenDraft,
  LeftOpenDraftsQuery,
} from "@inboxzero/mail-core/queries";
import type { SqlTransaction } from "./driver";

/** One account's mailbox drafts, newest first. */
export const DRAFTS_SQL = `SELECT message_id, conversation_id, subject, preview, to_json, received_at_ms
FROM effective_messages
WHERE account_id = ? AND in_draft = 1 AND in_trash = 0 AND in_spam = 0
ORDER BY received_at_ms DESC`;

/**
 * Drafts the user started and left, by what the mailbox holds. Cue's reply
 * suggestions stay in Cue until the user edits one, which only then becomes
 * a mailbox draft, so they aren't here. A sent draft has left the mailbox's
 * drafts. Each
 * conversation is judged by its newest draft, which is skipped while it is
 * still being written or holds no body.
 */
export async function readLeftOpenDrafts(
  tx: SqlTransaction,
  input: LeftOpenDraftsQuery,
): Promise<LeftOpenDraft[]> {
  const limit = Math.max(input.limit, 0);
  const drafts: LeftOpenDraft[] = [];
  for (const accountId of new Set(input.accountIds)) {
    if (limit === 0) break;
    const rows = await tx.query(DRAFTS_SQL, [accountId]);
    const seen = new Set<string>();
    let found = 0;
    for (const row of rows) {
      if (found >= limit) break;
      const conversationId = String(row.conversation_id);
      if (seen.has(conversationId)) continue;
      seen.add(conversationId);
      const savedAtMs = Number(row.received_at_ms);
      if (savedAtMs >= input.savedBeforeMs) continue;
      if (!String(row.preview).trim()) continue;
      drafts.push({
        accountId,
        conversationId,
        messageId: String(row.message_id),
        subject: String(row.subject),
        to: parseAddresses(row.to_json),
        savedAtMs,
      });
      found++;
    }
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
