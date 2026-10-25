import { LOCAL_MIGRATIONS } from "./local-migrations";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { foldPersonName } from "@inboxzero/mail-core/sender-check";
import type { SqlTransaction, SqlValue } from "./driver";
import type { SearchSupport } from "./queries";

// A word typed into a search also finds mail with the people it names: mail
// from or to someone whose name starts with it, even when the name is in no
// header or body the text index holds. Names are read from the contact index
// the store already keeps, folded so "jose" finds José, and only for people
// you have written to, so a stranger putting a friend's name on their mail
// doesn't join the friend's results. A name only counts from mail you sent
// or from the person's own From line: anyone can write any name beside
// someone else's address on the To or Cc line of mail they send you.

// Rows of contact_stats whose name the reader or the person wrote.
const TRUSTED_NAME = "name != '' AND (sent = 1 OR sender = email)";
// Backfill rows per call, so a large mailbox's first open isn't held up.
const BACKFILL_BATCH = 200;

export async function migrateContactNameTokens(tx: SqlTransaction) {
  await tx.exec(`
    CREATE TABLE IF NOT EXISTS contact_name_tokens (
      account_id TEXT NOT NULL, token TEXT NOT NULL, email TEXT NOT NULL,
      PRIMARY KEY(account_id, token, email)
    );
    CREATE INDEX IF NOT EXISTS contact_name_tokens_email
      ON contact_name_tokens(account_id, email);
    CREATE TABLE IF NOT EXISTS contact_name_backfill_state (
      id INTEGER PRIMARY KEY CHECK(id = 1), after_rowid INTEGER NOT NULL, complete INTEGER NOT NULL
    );
  `);
  const applied = await tx.query(
    "SELECT 1 FROM schema_migrations WHERE id = ?",
    [LOCAL_MIGRATIONS.contactNameTokens.id],
  );
  if (applied.length) return;
  // Contacts indexed before names were are read in by indexContactNameBacklog.
  await tx.exec(`
    INSERT OR REPLACE INTO contact_name_backfill_state VALUES (1, 0, 0);
    INSERT INTO schema_migrations(id, name) VALUES (${LOCAL_MIGRATIONS.contactNameTokens.id}, '${LOCAL_MIGRATIONS.contactNameTokens.name}');
  `);
}

/** Indexes one batch of the people indexed before names were. */
export async function indexContactNameBacklog(
  tx: SqlTransaction,
): Promise<{ remaining: boolean }> {
  const [state] = await tx.query(
    "SELECT after_rowid, complete FROM contact_name_backfill_state WHERE id = 1",
  );
  if (!state || Number(state.complete) === 1) return { remaining: false };
  const rows = await tx.query(
    `SELECT rowid, account_id, email FROM contact_stats
     WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    [Number(state.after_rowid), BACKFILL_BATCH],
  );
  const people = new Map(
    rows.map((row) => [
      `${row.account_id}\u0000${row.email}`,
      [String(row.account_id), String(row.email)] as const,
    ]),
  );
  for (const [accountId, email] of people.values())
    await replaceContactNameTokens(tx, accountId, email);
  if (rows.length)
    await tx.execute(
      "UPDATE contact_name_backfill_state SET after_rowid = ? WHERE id = 1",
      [Number(rows.at(-1)?.rowid)],
    );
  else
    await tx.execute(
      "UPDATE contact_name_backfill_state SET complete = 1 WHERE id = 1",
    );
  return { remaining: rows.length > 0 };
}

/** Rebuilds one person's name tokens from the names they can be trusted by. */
export async function replaceContactNameTokens(
  tx: SqlTransaction,
  accountId: string,
  email: string,
) {
  await tx.execute(
    "DELETE FROM contact_name_tokens WHERE account_id = ? AND email = ?",
    [accountId, email],
  );
  const names = await tx.query(
    `SELECT DISTINCT name FROM contact_stats
     WHERE account_id = ? AND email = ? AND ${TRUSTED_NAME}`,
    [accountId, email],
  );
  const tokens = new Set<string>();
  for (const row of names) {
    const name = String(row.name);
    // A name that is an address says nothing about the person.
    if (name.includes("@")) continue;
    for (const token of foldPersonName(name).split(/[^\p{L}\p{N}]+/u))
      if (token) tokens.add(token);
  }
  for (const token of tokens)
    await tx.execute(
      "INSERT OR IGNORE INTO contact_name_tokens VALUES (?, ?, ?)",
      [accountId, token, email],
    );
}

/**
 * `search` with the words of `predicate`'s text searches that start the name
 * of someone in `accountIds` you have written to, which the text conditions
 * then also match through that person's mail.
 */
export async function withContactNames(
  tx: SqlTransaction,
  search: SearchSupport,
  predicate: MailPredicate,
  accountIds: string[],
): Promise<SearchSupport> {
  const words = new Set<string>();
  collectNameWords(predicate, words);
  if (!words.size || !accountIds.length) return search;
  const contactNames = new Set<string>();
  const accounts = accountIds.map(() => "?").join(",");
  for (const word of words) {
    const [row] = await tx.query(
      `SELECT 1 AS found FROM contact_name_tokens n
       WHERE n.account_id IN (${accounts}) AND n.token >= ? AND n.token < ?
         AND ${WROTE_TO_THEM}
       LIMIT 1`,
      [...accountIds, word, `${word}\u{10ffff}`],
    );
    if (row) contactNames.add(word);
  }
  return contactNames.size
    ? { ...search, contactNames: { words: contactNames, accountIds } }
    : search;
}

/**
 * The words of a text condition that also match people by name, and the
 * rest, which match text only. Only a term search in any field does: a
 * phrase, subject or body asks for that text itself.
 */
export function splitNameWords(
  predicate: Extract<MailPredicate, { kind: "text" }>,
  search: SearchSupport,
): { names: string[]; others: string[] } {
  const words = predicate.value.split(/\s+/).filter(Boolean);
  const contactNames = search.contactNames?.words;
  if (!contactNames || !searchesNames(predicate))
    return { names: [], others: words };
  const names: string[] = [];
  const others: string[] = [];
  for (const word of words) {
    const token = nameToken(word);
    if (token && contactNames.has(token)) names.push(word);
    else others.push(word);
  }
  return { names, others };
}

/**
 * The messages from or to someone you have written to whose name starts with
 * `word`, as (account_id, message_id) rows, in the accounts `search` names
 * people for.
 */
export function contactNameMessages(
  word: string,
  search: SearchSupport,
): { sql: string; bindings: SqlValue[] } {
  const token = nameToken(word);
  if (!token) throw new Error("Not a name word");
  const accountIds = search.contactNames?.accountIds ?? [];
  // CROSS JOIN keeps the plan on the name's tokens, and the index on each
  // person lists their messages; left to itself SQLite reads every
  // interaction in the account for each name.
  return {
    sql: `SELECT i.account_id, i.message_id FROM contact_name_tokens n
      CROSS JOIN contact_interactions i INDEXED BY contact_interaction_group
        ON i.account_id = n.account_id AND i.email = n.email
      WHERE n.account_id IN (${accountIds.map(() => "?").join(",")})
        AND n.token >= ? AND n.token < ? AND ${WROTE_TO_THEM}`,
    bindings: [...accountIds, token, `${token}\u{10ffff}`],
  };
}

// Mail you sent them, and not an address of yours: your own name would
// otherwise find nearly every message.
const WROTE_TO_THEM = `EXISTS (
    SELECT 1 FROM contact_stats s
    WHERE s.account_id = n.account_id AND s.email = n.email AND s.sent = 1
  ) AND NOT EXISTS (
    SELECT 1 FROM contact_stats o
    WHERE o.account_id = n.account_id AND o.sender = n.email AND o.sent = 1
  )`;

function searchesNames(predicate: Extract<MailPredicate, { kind: "text" }>) {
  return predicate.field === "any" && predicate.match === "term";
}

function collectNameWords(predicate: MailPredicate, words: Set<string>) {
  switch (predicate.kind) {
    case "text":
      if (!searchesNames(predicate)) return;
      for (const word of predicate.value.split(/\s+/)) {
        const token = nameToken(word);
        if (token) words.add(token);
      }
      return;
    case "all":
    case "any":
      for (const child of predicate.predicates) collectNameWords(child, words);
      return;
    // Leaving a person out of the results stays a matter of their text.
    case "not":
      return;
    case "search":
      collectNameWords(predicate.local, words);
      return;
    default:
      return;
  }
}

// One word of a name as the index keeps it; a single letter would match
// most of the address book.
function nameToken(word: string): string | null {
  const token = foldPersonName(word);
  return /^[\p{L}\p{N}]{2,}$/u.test(token) ? token : null;
}
