import { LOCAL_MIGRATIONS } from "./local-migrations";
import type { SqlTransaction } from "./driver";

/**
 * Adds the UTC offset from each message's Date header, so a reply can show
 * the sender's hour. Mail stored before it is not read again for it: the
 * column fills as each message's next provider copy lands.
 */
export async function migrateSenderUtcOffsets(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.senderUtcOffsets.id],
  );
  if (applied.length) return;
  for (const table of ["messages", "effective_messages"]) {
    const columns = await tx.query(`PRAGMA table_info(${table})`);
    if (!columns.some((column) => column.name === "sender_utc_offset_minutes"))
      await tx.exec(
        `ALTER TABLE ${table} ADD COLUMN sender_utc_offset_minutes INTEGER`,
      );
  }
  await tx.execute(
    "INSERT OR IGNORE INTO schema_migrations(id, name) VALUES (?, ?)",
    [
      LOCAL_MIGRATIONS.senderUtcOffsets.id,
      LOCAL_MIGRATIONS.senderUtcOffsets.name,
    ],
  );
}
