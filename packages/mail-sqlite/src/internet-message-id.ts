import type { SqlTransaction } from "./driver";

/**
 * Adds each message's Message-ID header. Mail stored before it is not read
 * again for it: the column fills as each message's next provider copy lands.
 */
export async function migrateInternetMessageIds(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = 16",
  );
  if (applied.length) return;
  const columns = await tx.query("PRAGMA table_info(messages)");
  if (!columns.some((column) => column.name === "internet_message_id"))
    await tx.exec("ALTER TABLE messages ADD COLUMN internet_message_id TEXT");
  await tx.execute(
    "INSERT OR IGNORE INTO schema_migrations(id, name) VALUES (16, '0016-internet-message-ids')",
  );
}
