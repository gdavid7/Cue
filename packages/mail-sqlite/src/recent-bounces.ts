import type {
  RecentBounce,
  RecentBouncesQuery,
} from "@inboxzero/mail-core/queries";
import type { SqlTransaction } from "./driver";

/**
 * Inbox mail in one account since a time that may be a bounce, newest first,
 * on the inbox index. The address match is only a cheap first cut; the
 * sender is checked exactly after.
 */
export const BOUNCE_CANDIDATES_SQL = `SELECT message_id, conversation_id, from_address, subject, received_at_ms
FROM effective_messages
WHERE account_id = ? AND in_inbox = 1 AND received_at_ms >= ?
  AND in_sent = 0 AND in_draft = 0 AND in_trash = 0 AND in_spam = 0
  AND (instr(lower(from_address), 'mailer-daemon') > 0
    OR instr(lower(from_address), 'postmaster') > 0)
ORDER BY received_at_ms DESC`;

/** What the user last sent in a conversation, on the conversation index. */
export const LAST_SENT_SQL = `SELECT subject, received_at_ms
FROM effective_messages
WHERE account_id = ? AND conversation_id = ?
  AND in_sent = 1 AND in_draft = 0 AND in_trash = 0
ORDER BY received_at_ms DESC
LIMIT 1`;

/**
 * Bounces still in the inbox, from a mail server's own address. Never by
 * subject or body wording, which changes with the server and the language.
 * One per conversation, its newest, and none once the user has sent in the
 * conversation since, as when they sent it again to a corrected address.
 */
export async function readRecentBounces(
  tx: SqlTransaction,
  input: RecentBouncesQuery,
): Promise<RecentBounce[]> {
  const bounces: RecentBounce[] = [];
  for (const accountId of new Set(input.accountIds)) {
    if (input.limit <= 0) break;
    const rows = await tx.query(BOUNCE_CANDIDATES_SQL, [
      accountId,
      input.receivedSinceMs,
    ]);
    const seen = new Set<string>();
    let found = 0;
    for (const row of rows) {
      if (found >= input.limit) break;
      const conversationId = String(row.conversation_id);
      if (seen.has(conversationId)) continue;
      if (!isBounceSender(String(row.from_address))) continue;
      seen.add(conversationId);
      const receivedAtMs = Number(row.received_at_ms);
      const [sent] = await tx.query(LAST_SENT_SQL, [accountId, conversationId]);
      if (sent && Number(sent.received_at_ms) > receivedAtMs) continue;
      bounces.push({
        accountId,
        conversationId,
        messageId: String(row.message_id),
        subject: String(row.subject),
        sentSubject: sent && String(sent.subject) ? String(sent.subject) : null,
        receivedAtMs,
      });
      found++;
    }
  }
  return bounces
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
    .slice(0, Math.max(input.limit, 0));
}

/**
 * A From header whose address is a mail server's own, on any domain:
 * `mailer-daemon` or `postmaster`, in any case, with or without a domain
 * or a `+tag`.
 */
export function isBounceSender(from: string) {
  const address = (from.match(/<([^<>]*)>\s*$/)?.[1] ?? from).trim();
  const at = address.lastIndexOf("@");
  const local = (at === -1 ? address : address.slice(0, at))
    .replace(/^"(.*)"$/, "$1")
    .toLowerCase();
  return /^(?:mailer-daemon|postmaster)(?:\+[^\s@]*)?$/.test(local);
}
