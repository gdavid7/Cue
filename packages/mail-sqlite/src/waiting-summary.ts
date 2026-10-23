import type { MailWaitingSummary } from "@inboxzero/mail-core/engine";
import { DEFERRED_DISPATCH_MIN_HOLD_MS } from "@inboxzero/mail-core/operations";
import type { SqlTransaction } from "./driver";
import { LOCAL_MIGRATIONS } from "./local-migrations";
import { connectionStatus } from "./store-read-utils";

// Changes the engine still means to deliver. A partly applied change
// (needs_attention) is not on its way anywhere, so it's left out.
const WAITING_STATUSES = [
  "preparing",
  "queued",
  "executing",
  "verifying",
  "retry_wait",
  "uncertain",
  "blocked_auth",
] as const;

/**
 * The waiting summary is polled while the app is open, so it reads only the
 * rows still on their way, through this index, instead of every operation
 * the account has ever made.
 */
export async function migrateOperationsAccountStatusIndex(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.operationsAccountStatusIndex.id],
  );
  if (applied.length) return;
  await tx.exec(`
    CREATE INDEX IF NOT EXISTS operations_account_status
      ON operations(account_id, status);
  `);
  await tx.execute("INSERT INTO schema_migrations(id, name) VALUES (?, ?)", [
    LOCAL_MIGRATIONS.operationsAccountStatusIndex.id,
    LOCAL_MIGRATIONS.operationsAccountStatusIndex.name,
  ]);
}

/**
 * One grouped read of each account's changes still on their way. It takes
 * only a change's kind and on/off flags from its payload: never a label,
 * folder or category id, an address or anything else a person wrote, so
 * nothing from a message can reach the page that shows it.
 */
export async function readWaitingSummary(
  tx: SqlTransaction,
  accountIds: string[],
  nowMs: number,
): Promise<MailWaitingSummary[]> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const accountList = ids.map(() => "?").join(",");
  const statusList = WAITING_STATUSES.map(() => "?").join(",");
  // A send in its undo window, or scheduled for later, is the server's to
  // hold; it starts waiting when it falls due.
  const sendAt = "COALESCE(json_extract(payload_json, '$.sendAtMs'), 0)";
  const rows = await tx.query(
    `SELECT
       account_id,
       status,
       COALESCE(json_extract(payload_json, '$.kind'), 'unknown') AS kind,
       json_extract(payload_json, '$.change.kind') AS change_kind,
       COALESCE(
         json_extract(payload_json, '$.change.read'),
         json_extract(payload_json, '$.change.starred'),
         json_extract(payload_json, '$.change.spam'),
         json_extract(payload_json, '$.change.present')
       ) AS change_on,
       json_extract(payload_json, '$.change.membership') AS membership,
       (next_attempt_at_ms IS NOT NULL AND next_attempt_at_ms - ? >= ?) AS held_offline,
       COUNT(*) AS n,
       MIN(MAX(created_at_ms, ${sendAt})) AS oldest
     FROM operations
     WHERE account_id IN (${accountList})
       AND status IN (${statusList})
       AND ${sendAt} <= ?
     GROUP BY account_id, status, kind, change_kind, change_on, membership, held_offline`,
    [nowMs, DEFERRED_DISPATCH_MIN_HOLD_MS, ...ids, ...WAITING_STATUSES, nowMs],
  );
  const accounts = await tx.query(
    `SELECT account_id, connection FROM accounts WHERE account_id IN (${accountList})`,
    ids,
  );
  return ids.map((accountId) => {
    const groups = rows
      .filter((row) => String(row.account_id) === accountId)
      .map((row) => ({
        status: String(
          row.status,
        ) as MailWaitingSummary["groups"][number]["status"],
        kind: String(row.kind),
        changeKind: row.change_kind == null ? null : String(row.change_kind),
        on: row.change_on == null ? null : Number(row.change_on) === 1,
        membership: membershipOf(row.membership),
        heldOffline: Number(row.held_offline) === 1,
        count: Number(row.n),
        oldestWaitingAtMs: Number(row.oldest),
      }));
    const connection = accounts.find(
      (row) => String(row.account_id) === accountId,
    )?.connection;
    return {
      accountId,
      connection: connectionStatus(connection),
      oldestWaitingAtMs: groups.length
        ? Math.min(...groups.map((group) => group.oldestWaitingAtMs))
        : null,
      groups,
    };
  });
}

function membershipOf(
  value: unknown,
): MailWaitingSummary["groups"][number]["membership"] {
  return value === "label" || value === "category" ? value : null;
}
