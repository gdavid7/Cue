import {
  NEVER_READ_MIN_MESSAGES,
  type NeverReadSender,
  type NeverReadSendersQuery,
} from "@inboxzero/mail-core/queries";
import { parseAddress } from "./contact-suggestions";
import type { SqlTransaction } from "./driver";

/**
 * One account's mail since a time, per From header as stored: received mail
 * in or out of the inbox, so a sender opened and then archived counts as
 * read. `in_inbox IN (0, 1)` keeps the range on `effective_inbox_order`;
 * one address under several names is merged after.
 */
export const NEVER_READ_SENDERS_SQL = `SELECT from_address,
       SUM(in_inbox) AS inbox_count,
       SUM(read) AS read_count,
       MAX(received_at_ms) AS last_at
FROM effective_messages
WHERE account_id = ? AND in_inbox IN (0, 1) AND received_at_ms >= ?
  AND in_sent = 0 AND in_draft = 0 AND in_trash = 0 AND in_spam = 0
GROUP BY from_address`;

/**
 * Senders who mail often and are never opened: in each account, at least
 * `NEVER_READ_MIN_MESSAGES` inbox messages in the window and nothing from
 * them read, archived mail included. Uses local read state, so a message
 * marked read here counts at once.
 */
export async function readNeverReadSenders(
  tx: SqlTransaction,
  input: NeverReadSendersQuery,
): Promise<NeverReadSender[]> {
  const own = new Set(
    input.ownAddresses.map((address) => address.trim().toLowerCase()),
  );
  const senders: NeverReadSender[] = [];
  for (const accountId of new Set(input.accountIds)) {
    const rows = await tx.query(NEVER_READ_SENDERS_SQL, [
      accountId,
      input.receivedSinceMs,
    ]);
    const byEmail = new Map<
      string,
      NeverReadSender & { read: number; namedAtMs: number }
    >();
    for (const row of rows) {
      const address = parseAddress(String(row.from_address));
      if (!address || own.has(address.email)) continue;
      const lastAt = Number(row.last_at);
      const sender = byEmail.get(address.email) ?? {
        accountId,
        email: address.email,
        name: null,
        count: 0,
        lastReceivedAtMs: 0,
        read: 0,
        namedAtMs: -1,
      };
      sender.count += Number(row.inbox_count);
      sender.read += Number(row.read_count);
      sender.lastReceivedAtMs = Math.max(sender.lastReceivedAtMs, lastAt);
      if (address.name && lastAt > sender.namedAtMs) {
        sender.name = address.name;
        sender.namedAtMs = lastAt;
      }
      byEmail.set(address.email, sender);
    }
    for (const { read, namedAtMs: _, ...sender } of byEmail.values())
      if (read === 0 && sender.count >= NEVER_READ_MIN_MESSAGES)
        senders.push(sender);
  }
  return senders
    .sort(
      (a, b) => b.count - a.count || b.lastReceivedAtMs - a.lastReceivedAtMs,
    )
    .slice(0, input.limit);
}
