import type {
  WaitingOnYouConversation,
  WaitingOnYouQuery,
} from "@inboxzero/mail-core/queries";
import type { SqlTransaction } from "./driver";

/**
 * Inbox conversations whose newest message may wait on the user's reply, per
 * account newest first, then merged. Each row walks the inbox index from the
 * newest message and stops at the limit; the checks on each are index lookups
 * (the conversation's later messages, the message's sender in the contact
 * index, and whether the user ever wrote to them).
 */
export async function readWaitingOnYou(
  tx: SqlTransaction,
  input: WaitingOnYouQuery,
): Promise<WaitingOnYouConversation[]> {
  const rows: WaitingOnYouConversation[] = [];
  if (input.limit <= 0) return rows;
  const own = JSON.stringify(
    input.ownAddresses.map((address) => address.trim().toLowerCase()),
  );
  for (const accountId of new Set(input.accountIds)) {
    const excluded = input.excludedLabelIds?.[accountId] ?? [];
    const result = await tx.query(
      `SELECT l.message_id, l.conversation_id, l.from_address, l.subject,
              l.preview, l.received_at_ms, l.read, l.starred
       FROM effective_messages l
       WHERE l.account_id = ? AND l.in_inbox = 1 AND l.received_at_ms >= ?
         AND l.in_sent = 0 AND l.in_draft = 0 AND l.in_trash = 0 AND l.in_spam = 0
         -- Outlook can file the user's own message in the inbox, not Sent.
         AND NOT EXISTS (
           SELECT 1 FROM json_each(?) o
           WHERE lower(trim(l.from_address)) = o.value
             OR instr(lower(l.from_address), '<' || o.value || '>') > 0
         )
         -- The inbox's main tab: no other Gmail tab, not Outlook's Other.
         AND (l.inbox_section IS NULL OR l.inbox_section != 'other')
         AND NOT EXISTS (
           SELECT 1 FROM json_each(l.category_ids_json)
           WHERE value LIKE 'CATEGORY\\_%' ESCAPE '\\'
             AND value != 'CATEGORY_PERSONAL'
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(l.label_ids_json)
           WHERE value IN (${placeholders(excluded)})
         )
         AND NOT EXISTS (
           SELECT 1 FROM json_each(l.category_ids_json)
           WHERE value IN (${placeholders(excluded)})
         )
         -- The conversation's newest message, so nothing follows it, sent
         -- or otherwise.
         AND NOT EXISTS (
           SELECT 1 FROM effective_messages n
           WHERE n.account_id = l.account_id
             AND n.conversation_id = l.conversation_id
             AND n.in_draft = 0 AND n.in_trash = 0 AND n.in_spam = 0
             AND (n.received_at_ms > l.received_at_ms
               OR (n.received_at_ms = l.received_at_ms
                 AND n.message_id > l.message_id))
         )
         AND (
           EXISTS (
             SELECT 1 FROM effective_messages s
             WHERE s.account_id = l.account_id
               AND s.conversation_id = l.conversation_id
               AND s.in_sent = 1 AND s.in_draft = 0
           )
           OR EXISTS (
             SELECT 1 FROM contact_stats c
             WHERE c.account_id = l.account_id AND c.sent = 1
               AND c.email = (
                 SELECT sender FROM contact_interactions i
                 WHERE i.account_id = l.account_id
                   AND i.message_id = l.message_id
                 LIMIT 1
               )
           )
         )
       ORDER BY l.received_at_ms DESC, l.conversation_id
       LIMIT ?`,
      [
        accountId,
        input.receivedSinceMs,
        own,
        ...excluded,
        ...excluded,
        input.limit,
      ],
    );
    for (const row of result)
      rows.push({
        accountId,
        conversationId: String(row.conversation_id),
        messageId: String(row.message_id),
        from: String(row.from_address),
        subject: String(row.subject),
        preview: String(row.preview),
        receivedAtMs: Number(row.received_at_ms),
        unread: Number(row.read) === 0,
        starred: Number(row.starred) === 1,
      });
  }
  return rows
    .sort((a, b) => b.receivedAtMs - a.receivedAtMs)
    .slice(0, input.limit);
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(",") || "NULL";
}
