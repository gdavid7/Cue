import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import type { SqlTransaction } from "./driver";

/**
 * Each conversation's message key: the normalised Message-ID of its latest
 * message, the newest that isn't a draft or in the trash, else the newest.
 * One message delivered to several of the user's accounts has one key in
 * each, so All inboxes shows and counts it once. This table is the one place
 * the rule lives: conversation summaries and counts both read it.
 */
export async function migrateConversationMessageKeys(tx: SqlTransaction) {
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = 17",
  );
  if (applied.length) return;

  const columns = await tx.query("PRAGMA table_info(effective_messages)");
  if (!columns.some((column) => column.name === "message_key"))
    await tx.exec("ALTER TABLE effective_messages ADD COLUMN message_key TEXT");
  // Normalised here, as at every later write, by mail-core's one rule.
  const stored = await tx.query(
    "SELECT account_id, message_id, internet_message_id FROM messages WHERE internet_message_id IS NOT NULL",
  );
  for (const row of stored) {
    await tx.execute(
      "UPDATE effective_messages SET message_key = ? WHERE account_id = ? AND message_id = ?",
      [
        normalizeInternetMessageId(String(row.internet_message_id)),
        row.account_id,
        row.message_id,
      ],
    );
  }

  await tx.exec(`
    CREATE TABLE IF NOT EXISTS conversation_message_keys (
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      message_key TEXT NOT NULL,
      PRIMARY KEY (account_id, conversation_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS conversation_message_keys_by_key
      ON conversation_message_keys(message_key, account_id);
    INSERT OR REPLACE INTO conversation_message_keys(account_id, conversation_id, message_key)
    SELECT account_id, conversation_id, message_key FROM (
      SELECT account_id, conversation_id, message_key,
             ROW_NUMBER() OVER (
               PARTITION BY account_id, conversation_id
               ORDER BY ${LATEST_ORDER}
             ) AS rank
      FROM effective_messages
    )
    WHERE rank = 1 AND message_key IS NOT NULL;

    -- The conversations whose key is in more than one account: copies of
    -- one message, which counts across accounts count once. Kept small, so a
    -- count reads only these, not every conversation's key.
    CREATE TABLE IF NOT EXISTS shared_message_copies (
      message_key TEXT NOT NULL,
      account_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      PRIMARY KEY (message_key, account_id, conversation_id),
      FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
    ) WITHOUT ROWID;
    INSERT OR IGNORE INTO shared_message_copies(message_key, account_id, conversation_id)
    SELECT message_key, account_id, conversation_id FROM conversation_message_keys
    WHERE message_key IN (
      SELECT message_key FROM conversation_message_keys
      GROUP BY message_key HAVING MIN(account_id) < MAX(account_id)
    );
    -- Triggers never lean on OR IGNORE or OR REPLACE: the statement that
    -- fires them can override a trigger's conflict clause with its own (an
    -- upsert's DO UPDATE turns it into an abort), so each write first checks
    -- the row isn't there.
    CREATE TRIGGER IF NOT EXISTS shared_message_copies_after_insert
    AFTER INSERT ON conversation_message_keys
    BEGIN
      INSERT INTO shared_message_copies(message_key, account_id, conversation_id)
      SELECT c.message_key, c.account_id, c.conversation_id
      FROM conversation_message_keys c
      WHERE c.message_key = NEW.message_key
        AND EXISTS (
          SELECT 1 FROM conversation_message_keys
          WHERE message_key = NEW.message_key AND account_id <> NEW.account_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM shared_message_copies s
          WHERE s.message_key = c.message_key AND s.account_id = c.account_id
            AND s.conversation_id = c.conversation_id
        );
    END;
    CREATE TRIGGER IF NOT EXISTS shared_message_copies_after_delete
    AFTER DELETE ON conversation_message_keys
    BEGIN
      DELETE FROM shared_message_copies
      WHERE message_key = OLD.message_key AND account_id = OLD.account_id
        AND conversation_id = OLD.conversation_id;
      -- Left in one account, the rest are no longer anyone's copies.
      DELETE FROM shared_message_copies
      WHERE message_key = OLD.message_key
        AND (
          SELECT COUNT(DISTINCT account_id) FROM shared_message_copies
          WHERE message_key = OLD.message_key
        ) < 2;
    END;

    -- A new message changes the key only when it becomes the latest, which
    -- one indexed lookup tells; then the key is simply its own.
    CREATE TRIGGER IF NOT EXISTS conversation_message_keys_after_insert
    AFTER INSERT ON effective_messages
    WHEN NOT EXISTS (
      SELECT 1 FROM effective_messages o
      WHERE o.account_id = NEW.account_id AND o.conversation_id = NEW.conversation_id
        AND o.message_id <> NEW.message_id
        AND (
          (o.in_draft = 0 AND o.in_trash = 0) > (NEW.in_draft = 0 AND NEW.in_trash = 0)
          OR (
            (o.in_draft = 0 AND o.in_trash = 0) = (NEW.in_draft = 0 AND NEW.in_trash = 0)
            AND (
              o.received_at_ms > NEW.received_at_ms
              OR (o.received_at_ms = NEW.received_at_ms AND o.message_id > NEW.message_id)
            )
          )
        )
    )
    BEGIN
      DELETE FROM conversation_message_keys
      WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id
        AND message_key IS NOT NEW.message_key;
      INSERT INTO conversation_message_keys(account_id, conversation_id, message_key)
      SELECT NEW.account_id, NEW.conversation_id, NEW.message_key
      WHERE NEW.message_key IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM conversation_message_keys
          WHERE account_id = NEW.account_id AND conversation_id = NEW.conversation_id
        );
    END;
    CREATE TRIGGER IF NOT EXISTS conversation_message_keys_after_delete
    AFTER DELETE ON effective_messages
    BEGIN
      ${rebuildKey("OLD")}
    END;
    -- Most writes rewrite a message with the same values (a read flip goes
    -- through a full upsert), so only a change to what picks the key counts,
    -- and the old conversation is rebuilt only when the message left it.
    CREATE TRIGGER IF NOT EXISTS conversation_message_keys_after_update
    AFTER UPDATE OF account_id, conversation_id, message_id, received_at_ms,
      in_draft, in_trash, message_key
    ON effective_messages
    WHEN ${KEY_COLUMNS.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")}
    BEGIN
      ${rebuildKey("OLD", "(OLD.account_id IS NOT NEW.account_id OR OLD.conversation_id IS NOT NEW.conversation_id)")}
      ${rebuildKey("NEW")}
    END;
  `);
  await tx.execute(
    "INSERT INTO schema_migrations(id, name) VALUES (17, '0017-conversation-message-keys')",
  );
}

const LATEST_ORDER =
  "(in_draft = 0 AND in_trash = 0) DESC, received_at_ms DESC, message_id DESC";

// What decides a conversation's key, so the update trigger can skip the rest.
const KEY_COLUMNS = [
  "account_id",
  "conversation_id",
  "message_id",
  "received_at_ms",
  "in_draft",
  "in_trash",
  "message_key",
];

// A conversation's messages are few, and effective_messages is indexed by
// conversation, so each write reads just that conversation. The stored row
// is replaced only when the chosen key changed, which leaves the shared
// copies (and their triggers) alone on most writes.
function rebuildKey(row: "NEW" | "OLD", when = "1") {
  const conversation = `account_id = ${row}.account_id AND conversation_id = ${row}.conversation_id`;
  const chosen = `(SELECT message_key FROM effective_messages
      WHERE ${conversation}
      ORDER BY ${LATEST_ORDER}
      LIMIT 1)`;
  return `DELETE FROM conversation_message_keys
      WHERE ${when} AND ${conversation} AND message_key IS NOT ${chosen};
    INSERT INTO conversation_message_keys(account_id, conversation_id, message_key)
    SELECT ${row}.account_id, ${row}.conversation_id, chosen.message_key
    FROM (SELECT ${chosen} AS message_key) AS chosen
    WHERE ${when} AND chosen.message_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM conversation_message_keys WHERE ${conversation});`;
}
