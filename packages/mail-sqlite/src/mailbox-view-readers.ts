import type { LocalRevision } from "@inboxzero/mail-core/identities";
import type { MessageMetadata } from "@inboxzero/mail-core/messages";
import type {
  ConversationQuery,
  MailboxCountsQuery,
  MailboxCountsView,
  MailboxView,
  MailPredicate,
  WellKnownMailbox,
} from "@inboxzero/mail-core/queries";
import { withContactNames } from "./contact-name-search";
import type { SqlTransaction, SqlValue } from "./driver";
import {
  compilePredicate,
  type SearchSupport,
  searchDrivenSource,
} from "./queries";
import {
  connectionStatus,
  jsonStringArray,
  coversWholeMailbox,
  readCoverage,
  readRevision,
  uniqueStrings,
  worstConnection,
} from "./store-read-utils";

export function readMailboxViewFromSql(
  tx: SqlTransaction,
  query: ConversationQuery,
  search: SearchSupport,
): Promise<{ revision: LocalRevision; view: MailboxView }> {
  return readMailboxPages(tx, query, 1, search);
}

export const MAX_MAILBOX_WINDOW_PAGES = 40;

export function readMailboxWindowFromSql(
  tx: SqlTransaction,
  query: ConversationQuery,
  pageCount: number,
  search: SearchSupport,
): Promise<{ revision: LocalRevision; view: MailboxView }> {
  const pages = Math.min(
    MAX_MAILBOX_WINDOW_PAGES,
    Math.max(1, Math.trunc(pageCount)),
  );
  return readMailboxPages(tx, query, pages, search);
}

// Reads a window of pages with one ordered query and one count, rather than
// re-running the filter and counts for every page.
async function readMailboxPages(
  tx: SqlTransaction,
  query: ConversationQuery,
  pages: number,
  storeSearch: SearchSupport,
): Promise<{ revision: LocalRevision; view: MailboxView }> {
  const revision = await readRevision(tx);
  const search = await withContactNames(
    tx,
    storeSearch,
    query.predicate,
    query.accountIds,
  );
  const { conversations, nextPage } = await readConversationPages(
    tx,
    query,
    pages,
    search,
  );
  const { matching, unread } = await readCounts(
    tx,
    { ...query, search },
    conversationIndexFor(query.predicate),
  );
  const coverage = await readCoverage(tx, query.accountIds);
  const complete = coversWholeMailbox(coverage);
  const accountConnections = await tx.query(
    `SELECT connection FROM accounts WHERE account_id IN (${query.accountIds.map(() => "?").join(",")})`,
    query.accountIds,
  );
  return {
    revision,
    view: {
      conversations,
      counts: {
        matchingConversations: matching,
        unreadConversations: unread,
        extent: complete ? "complete_scope" : "local_coverage",
      },
      nextPage,
      coverage,
      connection: worstConnection(
        accountConnections.map((row) => connectionStatus(row.connection)),
      ),
    },
  };
}

export async function readMailboxCountsFromSql(
  tx: SqlTransaction,
  query: MailboxCountsQuery,
  search: SearchSupport,
): Promise<{ revision: LocalRevision; view: MailboxCountsView }> {
  const revision = await readRevision(tx);
  const counts: MailboxCountsView["counts"] = [];
  for (const target of query.targets) {
    const { matching, unread } = await readCounts(
      tx,
      { accountIds: query.accountIds, predicate: target.predicate, search },
      conversationIndexFor(target.predicate),
    );
    counts.push({
      id: target.id,
      matchingConversations: matching,
      unreadConversations: unread,
    });
  }
  return { revision, view: { counts } };
}

async function readConversationPages(
  tx: SqlTransaction,
  query: ConversationQuery,
  pages: number,
  search: SearchSupport,
) {
  const window = { ...query, pageSize: query.pageSize * pages };
  const index = conversationIndexFor(query.predicate);
  const rows = index
    ? await readIndexedRows(tx, window, index)
    : await readFilteredRows(tx, { ...window, search });
  const listed = rows.slice(0, window.pageSize);
  const conversations = [];
  for (let start = 0; start < listed.length; start += query.pageSize) {
    conversations.push(
      ...(await readConversationSummaries(
        tx,
        listed.slice(start, start + query.pageSize),
      )),
    );
  }
  const last = listed.at(-1);
  return {
    conversations,
    nextPage:
      rows.length > window.pageSize && last
        ? `${last.latest}\t${last.account_id}\t${last.conversation_id}`
        : null,
  };
}

type CountScope = {
  accountIds: string[];
  predicate: MailPredicate;
  search: SearchSupport;
};

type Counts = { matching: number; unread: number };

function readCounts(
  tx: SqlTransaction,
  scope: CountScope,
  index: ConversationIndex | null,
): Promise<Counts> {
  return index
    ? readIndexedCounts(tx, scope, index)
    : readFilteredCounts(tx, scope);
}

/**
 * Counts conversation rows ({account_id, conversation_id, latest, unread}).
 * Across accounts, All inboxes lists a message delivered to several of them
 * once (showCopiesOnce in apps/web), so copies count once too: conversations
 * sharing a stored message key pair up by their rank within each account,
 * newest first, as the list pairs them, and a pair is unread if any copy is.
 * Within one account each conversation counts, and Drafts are each account's
 * own. Only conversations whose key is in more than one account
 * (shared_message_copies) are looked at, so the extra cost grows with the
 * copies, not the mailbox.
 */
async function countConversationRows(
  tx: SqlTransaction,
  scope: CountScope,
  rows: { sql: string; bindings: SqlValue[] },
): Promise<Counts> {
  const [row] = await tx.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(unread), 0) AS u FROM (${rows.sql})`,
    rows.bindings,
  );
  const counts = { matching: Number(row?.n ?? 0), unread: Number(row?.u ?? 0) };
  if (scope.accountIds.length < 2 || mentionsDrafts(scope.predicate))
    return counts;
  // Each key's copies in scope; the hidden ones are all but one per pair.
  // One copy per account is the rule, so only a key with two conversations in
  // one account is ranked to pair it as the list does.
  const [hidden] = await tx.query(
    `WITH copies AS (
       SELECT k.message_key, s.account_id, s.conversation_id, s.latest, s.unread
       FROM shared_message_copies k
       CROSS JOIN (${rows.sql}) s
         ON s.account_id = k.account_id AND s.conversation_id = k.conversation_id
     ),
     per_key AS (
       SELECT message_key, COUNT(*) AS n, COUNT(DISTINCT account_id) AS accounts,
              SUM(unread) AS u, MAX(unread) AS shown
       FROM copies GROUP BY message_key
     ),
     ranked AS (
       SELECT message_key, unread,
              ROW_NUMBER() OVER (
                PARTITION BY message_key, account_id
                ORDER BY latest DESC, conversation_id
              ) AS rank
       FROM copies
       WHERE message_key IN (SELECT message_key FROM per_key WHERE n > accounts)
     ),
     pairs AS (
       SELECT n, u, shown FROM per_key WHERE n = accounts
       UNION ALL
       SELECT COUNT(*), SUM(unread), MAX(unread) FROM ranked
       GROUP BY message_key, rank
     )
     SELECT COALESCE(SUM(n - 1), 0) AS n, COALESCE(SUM(u - shown), 0) AS u
     FROM pairs`,
    rows.bindings,
  );
  return {
    matching: counts.matching - Number(hidden?.n ?? 0),
    unread: counts.unread - Number(hidden?.u ?? 0),
  };
}

function mentionsDrafts(predicate: MailPredicate): boolean {
  switch (predicate.kind) {
    case "all":
    case "any":
      return predicate.predicates.some(mentionsDrafts);
    case "not":
      return mentionsDrafts(predicate.predicate);
    case "role":
      return predicate.role === "draft";
    case "mailbox":
      return predicate.mailbox === "drafts";
    default:
      return false;
  }
}

function filteredScope(scope: CountScope) {
  const mailbox =
    scope.predicate.kind === "mailbox" ? scope.predicate.mailbox : null;
  const driven = searchDrivenSource(scope.predicate, scope.search);
  const compiled =
    mailbox === "archive" || mailbox === "all" || mailbox === "snoozed"
      ? { sql: "1=1", bindings: [] as SqlValue[] }
      : compilePredicate(driven?.rest ?? scope.predicate, scope.search);
  const accountPlaceholders = scope.accountIds.map(() => "?").join(",");
  const having = mailboxConversationHaving(mailbox);
  return {
    mailbox,
    from: driven?.from ?? "effective_messages e",
    where: `e.account_id IN (${accountPlaceholders}) AND ${compiled.sql}`,
    having,
    // In clause order: source, WHERE, HAVING.
    bindings: [
      ...(driven?.bindings ?? []),
      ...scope.accountIds,
      ...compiled.bindings,
      ...having.bindings,
    ],
  };
}

async function readFilteredRows(
  tx: SqlTransaction,
  query: ConversationQuery & CountScope,
) {
  const { from, where, having, bindings } = filteredScope(query);
  const cursor = query.after ? parseMailboxCursor(query.after) : null;
  const order = latestOrder(query.order);
  const cursorSql = cursor
    ? `WHERE latest ${order.past} ?
       OR (latest = ? AND account_id ${order.tiePast} ?)
       OR (latest = ? AND account_id = ? AND conversation_id ${order.tiePast} ?)`
    : "";
  return tx.query(
    `WITH grouped AS (
       SELECT e.account_id, e.conversation_id, MAX(e.received_at_ms) AS latest,
              MAX(CASE WHEN e.read = 0 THEN 1 ELSE 0 END) AS unread,
              MAX(e.starred) AS starred
       FROM ${from}
       WHERE ${where}
       GROUP BY e.account_id, e.conversation_id
       ${having.sql ? `HAVING ${having.sql}` : ""}
     )
     SELECT * FROM grouped
     ${cursorSql}
     ORDER BY latest ${order.latest}, account_id ${order.tie}, conversation_id ${order.tie}
     LIMIT ?`,
    [
      ...bindings,
      ...(cursor
        ? [
            cursor.latest,
            cursor.latest,
            cursor.accountId,
            cursor.latest,
            cursor.accountId,
            cursor.conversationId,
          ]
        : []),
      query.pageSize + 1,
    ],
  );
}

async function readFilteredCounts(
  tx: SqlTransaction,
  scope: CountScope,
): Promise<Counts> {
  const { mailbox, from, where, having, bindings } = filteredScope(scope);
  // A snoozed conversation counts as unread only through an unread message
  // that is itself snoozed.
  const snoozed = mailbox === "snoozed";
  return countConversationRows(tx, scope, {
    sql: `SELECT e.account_id, e.conversation_id, MAX(e.received_at_ms) AS latest,
            MAX(CASE WHEN e.read = 0${snoozed ? " AND IFNULL(e.snoozed_until_ms, 0) > ?" : ""} THEN 1 ELSE 0 END) AS unread
          FROM ${from}
          WHERE ${where}
          GROUP BY e.account_id, e.conversation_id
          ${having.sql ? `HAVING ${having.sql}` : ""}`,
    bindings: [...(snoozed ? [Date.now()] : []), ...bindings],
  });
}

function mailboxConversationHaving(mailbox: WellKnownMailbox | null): {
  sql: string;
  bindings: SqlValue[];
} {
  if (mailbox === "archive") {
    return {
      sql: "MAX(e.in_inbox) = 0 AND MAX(e.in_trash) = 0 AND MAX(e.in_spam) = 0",
      bindings: [],
    };
  }
  if (mailbox === "all") {
    return {
      sql: "MAX(e.in_trash) = 0 AND MAX(e.in_spam) = 0",
      bindings: [],
    };
  }
  if (mailbox === "snoozed") {
    return {
      sql: "MAX(IFNULL(e.snoozed_until_ms, 0)) > ?",
      bindings: [Date.now()],
    };
  }
  return { sql: "", bindings: [] };
}

type ConversationIndex = {
  source: string;
  sourceBindings: SqlValue[];
};

// Single-role and single-membership views read trigger-maintained indexes
// instead of scanning every message.
function conversationIndexFor(
  predicate: ConversationQuery["predicate"],
): ConversationIndex | null {
  if (predicate.kind === "role") return roleIndex(predicate.role);
  if (predicate.kind === "mailbox" && predicate.mailbox === "inbox") {
    return roleIndex("inbox");
  }
  if (predicate.kind === "membership") {
    const account = predicate.accountId ? " AND account_id = ?" : "";
    return {
      source: `(SELECT account_id, conversation_id, MAX(received_at_ms) AS latest_at_ms,
                       MAX(1 - read) AS unread, MAX(starred) AS starred
                FROM effective_message_memberships
                WHERE kind = ? AND membership_id = ?${account}
                GROUP BY account_id, conversation_id)`,
      sourceBindings: [
        predicate.membership,
        predicate.id,
        ...(predicate.accountId ? [predicate.accountId] : []),
      ],
    };
  }
  return null;
}

function roleIndex(role: MessageMetadata["roles"][number]): ConversationIndex {
  return {
    source:
      "(SELECT account_id, conversation_id, latest_at_ms, unread, starred FROM effective_role_conversations WHERE role = ?)",
    sourceBindings: [role],
  };
}

async function readIndexedRows(
  tx: SqlTransaction,
  query: ConversationQuery,
  index: ConversationIndex,
) {
  const { where, whereBindings } = indexedScope(query, index);
  const cursor = query.after ? parseMailboxCursor(query.after) : null;
  const order = latestOrder(query.order);
  const cursorSql = cursor
    ? `AND (
         c.latest_at_ms ${order.past} ?
         OR (c.latest_at_ms = ? AND c.account_id ${order.tiePast} ?)
         OR (c.latest_at_ms = ? AND c.account_id = ? AND c.conversation_id ${order.tiePast} ?)
       )`
    : "";
  return tx.query(
    `SELECT c.account_id, c.conversation_id, c.latest_at_ms AS latest, c.unread, c.starred
     FROM ${index.source} c
     WHERE ${where}
       ${cursorSql}
     ORDER BY c.latest_at_ms ${order.latest}, c.account_id ${order.tie}, c.conversation_id ${order.tie}
     LIMIT ?`,
    [
      ...whereBindings,
      ...(cursor
        ? [
            cursor.latest,
            cursor.latest,
            cursor.accountId,
            cursor.latest,
            cursor.accountId,
            cursor.conversationId,
          ]
        : []),
      query.pageSize + 1,
    ],
  );
}

async function readIndexedCounts(
  tx: SqlTransaction,
  scope: CountScope,
  index: ConversationIndex,
): Promise<Counts> {
  const { where, whereBindings } = indexedScope(scope, index);
  return countConversationRows(tx, scope, {
    sql: `SELECT c.account_id, c.conversation_id, c.latest_at_ms AS latest,
            (c.unread = 1) AS unread
          FROM ${index.source} c WHERE ${where}`,
    bindings: whereBindings,
  });
}

function indexedScope(
  scope: { accountIds: string[] },
  index: ConversationIndex,
) {
  const accountPlaceholders = scope.accountIds.map(() => "?").join(",");
  return {
    where: `c.account_id IN (${accountPlaceholders})`,
    whereBindings: [...index.sourceBindings, ...scope.accountIds],
  };
}

// Oldest first is newest first exactly reversed, ties included, so both walk
// role_conversation_order without sorting: oldest first reads it backwards.
function latestOrder(order: ConversationQuery["order"]) {
  return order === "oldest_first"
    ? { latest: "ASC", tie: "DESC", past: ">", tiePast: "<" }
    : { latest: "DESC", tie: "ASC", past: "<", tiePast: ">" };
}

function parseMailboxCursor(value: string) {
  const [latest, accountId, conversationId] = value.split("\t");
  const latestMs = Number(latest);
  if (!Number.isFinite(latestMs) || !accountId || !conversationId) {
    return null;
  }
  return { latest: latestMs, accountId, conversationId };
}

async function readConversationSummaries(
  tx: SqlTransaction,
  page: Array<Record<string, SqlValue>>,
) {
  if (page.length === 0) return [];
  const members = await tx.query(
    `SELECT account_id, conversation_id, message_id, subject, preview, from_address, to_json,
            received_at_ms, unread, starred, label_ids_json, roles_json, pending_operation_ids_json,
            has_attachments, message_key
     FROM (
       SELECT e.account_id, e.conversation_id, e.message_id, e.subject, e.preview, e.from_address,
              e.to_json, e.received_at_ms, e.read AS unread, e.starred, e.label_ids_json, e.roles_json,
              e.pending_operation_ids_json, e.has_attachments, k.message_key
       FROM effective_messages e
       LEFT JOIN conversation_message_keys k
         ON k.account_id = e.account_id AND k.conversation_id = e.conversation_id
       WHERE ${page
         .map(() => "(e.account_id = ? AND e.conversation_id = ?)")
         .join(" OR ")}
     )`,
    page.flatMap((row) => [row.account_id, row.conversation_id]),
  );
  const grouped = new Map<string, typeof members>();
  for (const member of members) {
    const key = `${member.account_id}\0${member.conversation_id}`;
    const list = grouped.get(key) ?? [];
    list.push(member);
    grouped.set(key, list);
  }
  return page.map((row) => {
    const key = `${row.account_id}\0${row.conversation_id}`;
    const conversationMembers = [...(grouped.get(key) ?? [])].sort(
      (left, right) => {
        const byTime =
          Number(left.received_at_ms) - Number(right.received_at_ms);
        if (byTime !== 0) return byTime;
        // Binary, as SQLite orders message_id in the conversation key rule.
        const leftId = String(left.message_id);
        const rightId = String(right.message_id);
        if (leftId === rightId) return 0;
        return leftId < rightId ? -1 : 1;
      },
    );
    const message = conversationMembers.at(-1);
    if (!message)
      throw new Error("Conversation query has no effective message");
    // A draft must not rename the conversation, including after it moves to trash.
    const subjectMessage =
      [...conversationMembers].reverse().find((member) => {
        const roles = jsonStringArray(member.roles_json);
        return !roles.includes("draft") && !roles.includes("trash");
      }) ?? message;
    return {
      key: {
        accountId: String(row.account_id),
        conversationId: String(row.conversation_id),
      },
      subject: String(subjectMessage.subject),
      preview: String(message.preview),
      from: String(message.from_address),
      to: jsonStringArray(message.to_json).join(", "),
      senders: conversationMembers
        .map((member) => String(member.from_address))
        .filter(Boolean),
      latestMessageAtMs: Number(row.latest),
      unread: Number(row.unread) === 1,
      starred: Number(row.starred) === 1,
      labelIds: uniqueStrings(
        conversationMembers.flatMap((member) =>
          jsonStringArray(member.label_ids_json),
        ),
      ),
      roles: uniqueStrings(
        conversationMembers.flatMap((member) =>
          jsonStringArray(member.roles_json),
        ),
      ) as MessageMetadata["roles"],
      pendingOperationIds: jsonStringArray(message.pending_operation_ids_json),
      latestMessageId: String(subjectMessage.message_id),
      ...(message.message_key == null
        ? {}
        : { latestInternetMessageId: String(message.message_key) }),
      hasAttachments: conversationMembers.some(
        (member) => Number(member.has_attachments) === 1,
      ),
    };
  });
}
