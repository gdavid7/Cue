import type {
  SenderHistory,
  SenderHistoryQuery,
} from "@inboxzero/mail-core/queries";
import { personNameKey } from "@inboxzero/mail-core/sender-check";
import { isAutomatedAddress } from "./contact-suggestions";
import type { SqlTransaction } from "./driver";
import { readCoverage } from "./store-read-utils";

/**
 * What the reader's "New address, familiar name" line needs about a sender,
 * from the contact index the store already keeps: whether the user has
 * written to this address, and which other addresses they have written to
 * under the same full name. Only mail the user sent vouches for a name, since
 * anyone can put any name on mail they send.
 */
export async function readSenderHistory(
  tx: SqlTransaction,
  input: SenderHistoryQuery,
): Promise<SenderHistory> {
  const email = input.email.trim().toLowerCase();
  const accountIds = [...new Set(input.accountIds)];
  const nameKey = personNameKey(input.name);
  const ready = await isReady(tx, accountIds);
  // The index keeps no history for machine addresses, so every one would
  // look new.
  if (!accountIds.length || !nameKey || isAutomatedAddress(email))
    return { ready, writtenTo: false, sameNameAddresses: [] };

  const accounts = placeholders(accountIds);
  const [writtenTo] = await tx.query(
    `SELECT 1 AS found FROM contact_stats
     WHERE account_id IN (${accounts}) AND email = ? AND sent = 1 LIMIT 1`,
    [...accountIds, email],
  );

  // The name's longest word narrows the people to read; the full name is
  // compared below, folded the same way the index folds it.
  const token = nameKey
    .split(" ")
    .reduce((longest, word) => (word.length > longest.length ? word : longest));
  const own = new Set(input.ownAddresses.map((a) => a.trim().toLowerCase()));
  const rows = await tx.query(
    `SELECT s.email, s.name, MAX(s.last_at) AS last_at
     FROM contact_name_tokens n
     CROSS JOIN contact_stats s
       ON s.account_id = n.account_id AND s.email = n.email
     WHERE n.account_id IN (${accounts}) AND n.token = ?
       AND s.sent = 1 AND s.name != '' AND s.email != ?
     GROUP BY s.email, s.name`,
    [...accountIds, token, email],
  );
  const latest = new Map<string, number>();
  for (const row of rows) {
    const address = String(row.email);
    if (own.has(address) || personNameKey(String(row.name)) !== nameKey)
      continue;
    latest.set(
      address,
      Math.max(latest.get(address) ?? 0, Number(row.last_at)),
    );
  }
  return {
    ready,
    writtenTo: Boolean(writtenTo),
    sameNameAddresses: [...latest.entries()]
      .sort(([a, at], [b, bt]) => bt - at || (a < b ? -1 : 1))
      .map(([address]) => address),
  };
}

// Until every scope has been listed and both backfills have read it, an
// address may look new only because the mail to it isn't here yet.
async function isReady(tx: SqlTransaction, accountIds: string[]) {
  const coverage = await readCoverage(tx, accountIds);
  if (coverage.some((scope) => scope.metadata === "partial")) return false;
  const [contacts] = await tx.query(
    "SELECT complete FROM contact_backfill_state WHERE id = 1",
  );
  const [names] = await tx.query(
    "SELECT complete FROM contact_name_backfill_state WHERE id = 1",
  );
  return (
    Number(contacts?.complete ?? 0) === 1 &&
    (!names || Number(names.complete) === 1)
  );
}

function placeholders(values: readonly unknown[]) {
  return values.map(() => "?").join(",") || "NULL";
}
