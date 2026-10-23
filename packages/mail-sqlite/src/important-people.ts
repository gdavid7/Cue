import {
  type ImportantPerson,
  normalizeImportantPersonAddress,
  type SetImportantPersonInput,
} from "@inboxzero/mail-core/important-people";
import { LOCAL_MIGRATIONS } from "./local-migrations";
import type { SqlTransaction } from "./driver";

// Far more than anyone stars; it only keeps one write bounded.
const MAX_ACCOUNTS_PER_WRITE = 50;

/**
 * Stars live on this device only, keyed by account and normalised address,
 * so an account's stars go when the account does.
 */
export async function migrateImportantPeople(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.importantPeople.id],
  );
  if (applied.length) return;
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS important_people (
      account_id TEXT NOT NULL,
      email TEXT NOT NULL,
      added_at_ms INTEGER NOT NULL,
      PRIMARY KEY (account_id, email)
    ) WITHOUT ROWID;
  `);
  await tx.execute(
    "INSERT OR IGNORE INTO schema_migrations(id, name) VALUES (?, ?)",
    [
      LOCAL_MIGRATIONS.importantPeople.id,
      LOCAL_MIGRATIONS.importantPeople.name,
    ],
  );
}

export async function readImportantPeople(
  tx: SqlTransaction,
  accountIds: string[],
): Promise<ImportantPerson[]> {
  const ids = [...new Set(accountIds)];
  if (ids.length === 0) return [];
  const rows = await tx.query(
    `SELECT account_id, email, added_at_ms FROM important_people
     WHERE account_id IN (${ids.map(() => "?").join(",")})
     ORDER BY added_at_ms, account_id, email`,
    ids,
  );
  return rows.map((row) => ({
    accountId: String(row.account_id),
    email: String(row.email),
    addedAtMs: Number(row.added_at_ms),
  }));
}

export async function writeImportantPerson(
  tx: SqlTransaction,
  input: SetImportantPersonInput,
  nowMs: number,
) {
  const email = normalizeImportantPersonAddress(input.email);
  if (!email) throw new Error("important_person_invalid_address");
  const accountIds = [...new Set(input.accountIds)];
  if (accountIds.length === 0 || accountIds.length > MAX_ACCOUNTS_PER_WRITE)
    throw new Error("important_person_invalid_accounts");
  for (const accountId of accountIds) {
    if (input.important) {
      await tx.execute(
        "INSERT OR IGNORE INTO important_people(account_id, email, added_at_ms) VALUES (?, ?, ?)",
        [accountId, email, nowMs],
      );
    } else {
      await tx.execute(
        "DELETE FROM important_people WHERE account_id = ? AND email = ?",
        [accountId, email],
      );
    }
  }
}

export async function deleteAccountImportantPeople(
  tx: SqlTransaction,
  accountId: string,
) {
  await tx.execute("DELETE FROM important_people WHERE account_id = ?", [
    accountId,
  ]);
}
