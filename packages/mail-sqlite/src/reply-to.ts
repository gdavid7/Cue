import { LOCAL_MIGRATIONS } from "./local-migrations";
import type { SqlTransaction } from "./driver";

/**
 * Adds each message's Reply-To addresses, so a reply goes where the sender
 * asked. Mail stored before it is not read again for it: the column fills as
 * each message's next provider copy lands, and until then a reply answers From.
 */
export async function migrateReplyTo(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.replyTo.id],
  );
  if (applied.length) return;
  for (const table of ["messages", "effective_messages"]) {
    const columns = await tx.query(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "reply_to_json"))
      await tx.exec(`ALTER TABLE ${table} ADD COLUMN reply_to_json TEXT`);
  }
  await tx.execute(
    "INSERT OR IGNORE INTO schema_migrations(id, name) VALUES (?, ?)",
    [LOCAL_MIGRATIONS.replyTo.id, LOCAL_MIGRATIONS.replyTo.name],
  );
}
