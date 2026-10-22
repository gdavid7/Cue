import {
  NEVER_READ_MIN_MESSAGES,
  NEVER_READ_SENDER_LIMIT,
  type NeverReadSender,
  type NeverReadSendersQuery,
} from "@inboxzero/mail-core/queries";
import { parseAddress } from "./contact-suggestions";
import type { SqlTransaction } from "./driver";

/**
 * One account's inbox mail since a time, per From header as stored. The
 * range comes off `effective_inbox_order`; grouping the raw header keeps
 * the work in SQLite, and one address under several names is merged after.
 */
export const NEVER_READ_SENDERS_SQL = `SELECT from_address,
       COUNT(*) AS count,
       SUM(read) AS read_count,
       MAX(received_at_ms) AS last_at
FROM effective_messages
WHERE account_id = ? AND in_inbox = 1 AND received_at_ms >= ?
GROUP BY from_address`;

/**
 * Senders who mail often and are never opened: in each account, at least
 * `NEVER_READ_MIN_MESSAGES` inbox messages in the window and none of them
 * read. Uses local read state, so a message marked read here counts at once.
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
      sender.count += Number(row.count);
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
    .slice(0, NEVER_READ_SENDER_LIMIT);
}
