import type {
  MessageSearchMatch,
  MessageSearchPage,
  MessageSearchQuery,
} from "@inboxzero/mail-core/queries";
import type { MessageMetadata } from "@inboxzero/mail-core/messages";
import type { SqlTransaction, SqlValue } from "./driver";
import {
  compilePredicate,
  type SearchSupport,
  searchDrivenSource,
} from "./queries";
import { readCoverage } from "./store-read-utils";

/**
 * Matching messages, newest first, each with its own fields: the predicate
 * is evaluated per message, as a provider's message search does, and the page
 * size counts messages rather than conversations.
 */
export async function readMessageSearch(
  tx: SqlTransaction,
  query: MessageSearchQuery,
  search: SearchSupport,
): Promise<MessageSearchPage> {
  const driven = searchDrivenSource(query.predicate, search);
  const compiled = compilePredicate(driven?.rest ?? query.predicate, search);
  const where = ["e.account_id = ?", compiled.sql];
  const bindings: SqlValue[] = [
    ...(driven?.bindings ?? []),
    query.accountId,
    ...compiled.bindings,
  ];
  if (query.fromAddress) {
    where.push(
      `(LOWER(e.from_address) = LOWER(?) OR LOWER(e.from_address) LIKE ? ESCAPE '\\')`,
    );
    bindings.push(
      query.fromAddress,
      `%<${escapeLike(query.fromAddress.toLowerCase())}>`,
    );
  }
  const cursor = query.after ? parseCursor(query.after) : null;
  if (cursor) {
    where.push(
      "(e.received_at_ms < ? OR (e.received_at_ms = ? AND e.message_id > ?))",
    );
    bindings.push(cursor.receivedAtMs, cursor.receivedAtMs, cursor.messageId);
  }
  const rows = await tx.query(
    `SELECT e.message_id, e.conversation_id, e.subject, e.preview, e.from_address,
            e.to_json, e.received_at_ms, e.read, e.starred, e.label_ids_json,
            e.category_ids_json, e.roles_json, e.has_attachments
     FROM ${driven?.from ?? "effective_messages e"}
     WHERE ${where.join(" AND ")}
     ORDER BY e.received_at_ms DESC, e.message_id ASC
     LIMIT ?`,
    [...bindings, query.pageSize + 1],
  );
  const listed = rows.slice(0, query.pageSize);
  const last = listed.at(-1);
  return {
    messages: listed.map(toMatch),
    nextPage:
      rows.length > query.pageSize && last
        ? `${last.received_at_ms}\t${last.message_id}`
        : null,
    coverage: await readCoverage(tx, [query.accountId]),
  };
}

function toMatch(row: Record<string, SqlValue>): MessageSearchMatch {
  return {
    messageId: String(row.message_id),
    conversationId: String(row.conversation_id),
    subject: String(row.subject),
    preview: String(row.preview),
    from: String(row.from_address),
    to: jsonStrings(row.to_json),
    receivedAtMs: Number(row.received_at_ms),
    read: Number(row.read) === 1,
    starred: Number(row.starred) === 1,
    labelIds: jsonStrings(row.label_ids_json),
    categoryIds: jsonStrings(row.category_ids_json),
    roles: jsonStrings(row.roles_json) as MessageMetadata["roles"],
    hasAttachments: Number(row.has_attachments) === 1,
  };
}

function parseCursor(value: string) {
  const [receivedAt, messageId] = value.split("\t");
  const receivedAtMs = Number(receivedAt);
  if (!Number.isFinite(receivedAtMs) || !messageId) return null;
  return { receivedAtMs, messageId };
}

function jsonStrings(value: SqlValue | undefined): string[] {
  try {
    const parsed = JSON.parse(String(value ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function escapeLike(value: string) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
