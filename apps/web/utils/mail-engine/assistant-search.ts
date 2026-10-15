import { TZDate } from "@date-fns/tz";
import { subDays, subMonths, subYears } from "date-fns";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  Coverage,
  MailPredicate,
  MessageSearchMatch,
  MessageSearchPage,
} from "@inboxzero/mail-core/queries";
import {
  isLocalPageToken,
  LOCAL_PAGE_TOKEN_PREFIX,
  LOCAL_SEARCH_LIMITS,
  type LocalMailSearchResult,
  localMailSearchResultSchema,
} from "@/utils/actions/assistant-local-search.validation";
import {
  parseSearchToken,
  tokenizeSearchQuery,
} from "@/utils/tokenize-search-query";

// The Gmail API reads after:/before: dates as midnight Pacific time.
const GMAIL_QUERY_TIME_ZONE = "America/Los_Angeles";
const DEFAULT_TIMEOUT_MS = 1500;

export type AssistantSearchRequest = {
  requestId: string;
  query: string;
  limit: number;
  pageToken?: string;
};

type LocalSearch = { predicate: MailPredicate; fromAddress: string | null };

/**
 * Answers one search the assistant asked this tab for and sends the answer
 * back, including "unavailable", so the assistant searches Gmail at once
 * instead of waiting out its timeout.
 */
export async function answerAssistantSearch({
  request,
  accountId,
  client,
  submit,
}: {
  request: AssistantSearchRequest;
  accountId: string;
  client: MailClient | null;
  submit: (input: {
    requestId: string;
    result: LocalMailSearchResult;
  }) => Promise<unknown>;
}) {
  const result: LocalMailSearchResult = client
    ? await searchLocalMail({
        client,
        accountId,
        query: request.query,
        limit: request.limit,
        pageToken: request.pageToken,
      }).catch(() => ({ status: "unavailable", reason: "error" }) as const)
    : { status: "unavailable", reason: "no_engine" };
  // An answer the server would reject is worth less than a quick handback.
  const accepted = localMailSearchResultSchema.safeParse(result).success
    ? result
    : ({ status: "unavailable", reason: "error" } as const);
  await submit({ requestId: request.requestId, result: accepted });
}

/**
 * Answers the assistant's Gmail search from the mail already in the local
 * store, in the shape the server's search returns: matching messages, each
 * with its own fields, newest first, `limit` counting messages. Says
 * `unavailable` (and the server searches Gmail instead) for a query it can't
 * answer exactly, before the mailbox has fully synced, or for word searches
 * before bodies are indexed, so a local answer is never a partial one.
 */
export async function searchLocalMail({
  client,
  accountId,
  query,
  limit,
  pageToken,
  now = new Date(),
  timeoutMs = DEFAULT_TIMEOUT_MS,
}: {
  client: MailClient;
  accountId: string;
  query: string;
  limit: number;
  pageToken?: string | null;
  now?: Date;
  timeoutMs?: number;
}): Promise<LocalMailSearchResult> {
  if (!client.searchMessages)
    return { status: "unavailable", reason: "no_engine" };
  const search = gmailQueryToLocalSearch(query, now);
  if (!search) return { status: "unavailable", reason: "unsupported_query" };
  const after = pageToken ? decodeLocalPageToken(pageToken) : null;
  if (pageToken && after === null)
    return { status: "unavailable", reason: "unsupported_query" };

  const page = await withTimeout(
    client.searchMessages({
      accountId,
      predicate: search.predicate,
      fromAddress: search.fromAddress,
      pageSize: Math.min(limit, LOCAL_SEARCH_LIMITS.messages),
      after,
    }),
    timeoutMs,
  );
  if (!page) return { status: "unavailable", reason: "timeout" };

  const coverage = page.coverage.filter((item) => item.accountId === accountId);
  if (!isComplete(coverage, "metadata"))
    return { status: "unavailable", reason: "not_synced" };
  if (hasText(search.predicate) && !isComplete(coverage, "indexedContent"))
    return { status: "unavailable", reason: "not_indexed" };

  return toResult(page);
}

/**
 * The local search for a Gmail query, or null when any part of it has Gmail
 * semantics the local store can't reproduce exactly (OR, negation, labels by
 * name, partial sender names, recipients, sizes, categories...).
 */
export function gmailQueryToLocalSearch(
  query: string,
  now: Date,
): LocalSearch | null {
  if (!query.trim()) return null;
  let mailbox: MailPredicate = { kind: "mailbox", mailbox: "all" };
  let fromAddress: string | null = null;
  const clauses: MailPredicate[] = [];
  const words: string[] = [];

  for (const token of tokenizeSearchQuery(query)) {
    if (/[(){}]/.test(token) && !token.startsWith('"')) return null;
    const { excluded, operator, value } = parseSearchToken(token);
    if (excluded || !value) return null;

    if (!operator) {
      if (token.startsWith('"')) {
        clauses.push({ kind: "text", field: "any", value, match: "phrase" });
        continue;
      }
      if (/^(OR|AND|AROUND)$/.test(value)) return null;
      if (!/^[\p{L}\p{N}][\p{L}\p{N}@._'-]*$/u.test(value)) return null;
      words.push(value);
      continue;
    }

    if (operator === "from") {
      // Gmail also matches partial names and addresses; only one whole
      // address means the same thing locally.
      if (fromAddress || !isWholeAddress(value)) return null;
      fromAddress = value.toLowerCase();
      continue;
    }
    const clause = operatorClause(operator, value, now);
    if (clause === null) return null;
    if (clause.kind === "mailbox") mailbox = clause;
    else clauses.push(clause);
  }

  if (words.length)
    clauses.push({
      kind: "text",
      field: "any",
      value: words.join(" "),
      match: "term",
    });
  return {
    predicate: { kind: "all", predicates: [mailbox, ...clauses] },
    fromAddress,
  };
}

function operatorClause(
  operator: string,
  value: string,
  now: Date,
): MailPredicate | null {
  switch (operator) {
    case "subject":
      return { kind: "text", field: "subject", value, match: "phrase" };
    case "has":
      return value.toLowerCase() === "attachment"
        ? { kind: "has_attachment", value: true }
        : null;
    case "is":
      return isClause(value.toLowerCase());
    case "in":
      return inClause(value.toLowerCase());
    case "after":
    case "before": {
      const at = gmailDateMs(value);
      if (at === null) return null;
      return operator === "after"
        ? { kind: "received", afterMs: at, beforeMs: null }
        : { kind: "received", afterMs: null, beforeMs: at };
    }
    case "newer_than":
    case "older_than": {
      const at = relativeAgeMs(value, now);
      if (at === null) return null;
      return operator === "newer_than"
        ? { kind: "received", afterMs: at, beforeMs: null }
        : { kind: "received", afterMs: null, beforeMs: at };
    }
    // to: also matches Cc and Bcc in Gmail, which the local index doesn't
    // reproduce; it stays with Gmail like every other operator not above.
    default:
      return null;
  }
}

function isClause(value: string): MailPredicate | null {
  if (value === "unread") return { kind: "read", value: false };
  if (value === "read") return { kind: "read", value: true };
  if (value === "starred") return { kind: "starred", value: true };
  return null;
}

function inClause(value: string): MailPredicate | null {
  switch (value) {
    case "inbox":
      return { kind: "mailbox", mailbox: "inbox" };
    case "sent":
      return { kind: "mailbox", mailbox: "sent" };
    case "drafts":
    case "draft":
      return { kind: "mailbox", mailbox: "drafts" };
    case "spam":
      return { kind: "mailbox", mailbox: "spam" };
    case "trash":
      return { kind: "mailbox", mailbox: "trash" };
    case "starred":
      return { kind: "mailbox", mailbox: "starred" };
    default:
      return null;
  }
}

function isWholeAddress(value: string) {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value);
}

function gmailDateMs(value: string): number | null {
  if (/^\d{9,11}$/.test(value)) return Number(value) * 1000;
  const match = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new TZDate(year, month - 1, day, GMAIL_QUERY_TIME_ZONE).getTime();
}

function relativeAgeMs(value: string, now: Date): number | null {
  const match = value.toLowerCase().match(/^(\d{1,4})([dmy])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const at = { d: subDays, m: subMonths, y: subYears }[
    match[2] as "d" | "m" | "y"
  ](now, amount);
  return at.getTime();
}

function toResult(page: MessageSearchPage): LocalMailSearchResult {
  const nextPageToken = page.nextPage
    ? encodeLocalPageToken(page.nextPage)
    : null;
  return {
    status: "ok",
    messages: page.messages
      .filter(
        (message) =>
          message.messageId.length <= LOCAL_SEARCH_LIMITS.id &&
          message.conversationId.length <= LOCAL_SEARCH_LIMITS.id,
      )
      .slice(0, LOCAL_SEARCH_LIMITS.messages)
      .map((message) => ({
        id: message.messageId,
        threadId: message.conversationId,
        subject: clamp(message.subject, LOCAL_SEARCH_LIMITS.subject),
        from: clamp(message.from, LOCAL_SEARCH_LIMITS.address),
        to: clamp(message.to.join(", "), LOCAL_SEARCH_LIMITS.recipients),
        snippet: clamp(message.preview, LOCAL_SEARCH_LIMITS.snippet),
        date: new Date(message.receivedAtMs).toISOString(),
        labelIds: gmailLabelIds(message)
          .filter((labelId) => labelId.length <= LOCAL_SEARCH_LIMITS.id)
          .slice(0, LOCAL_SEARCH_LIMITS.labels),
        hasAttachments: message.hasAttachments,
      })),
    ...(nextPageToken && nextPageToken.length <= LOCAL_SEARCH_LIMITS.pageToken
      ? { nextPageToken }
      : {}),
  };
}

function clamp(value: string, max: number) {
  return value.length > max ? value.slice(0, max) : value;
}

// The store keeps Gmail's system labels as roles and flags; a Gmail search
// result lists them as label ids, so they are put back.
const ROLE_LABEL_IDS: Record<MessageSearchMatch["roles"][number], string> = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
};

function gmailLabelIds(message: MessageSearchMatch) {
  return [
    ...new Set([
      ...message.roles.map((role) => ROLE_LABEL_IDS[role]),
      ...(message.read ? [] : ["UNREAD"]),
      ...(message.starred ? ["STARRED"] : []),
      ...message.categoryIds,
      ...message.labelIds,
    ]),
  ];
}

function hasText(predicate: MailPredicate): boolean {
  switch (predicate.kind) {
    case "text":
      return true;
    case "all":
    case "any":
      return predicate.predicates.some(hasText);
    case "not":
      return hasText(predicate.predicate);
    default:
      return false;
  }
}

function isComplete(
  coverage: Coverage[],
  field: "metadata" | "indexedContent",
): boolean {
  return (
    coverage.length > 0 && coverage.every((item) => item[field] === "complete")
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Base64url, so the store's tab-separated cursor stays one opaque token.
function encodeLocalPageToken(cursor: string) {
  const bytes = new TextEncoder().encode(cursor);
  const base64 = btoa(String.fromCharCode(...bytes));
  const base64url = base64
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return `${LOCAL_PAGE_TOKEN_PREFIX}${base64url}`;
}

function decodeLocalPageToken(pageToken: string): string | null {
  if (!isLocalPageToken(pageToken)) return null;
  try {
    const base64 = pageToken
      .slice(LOCAL_PAGE_TOKEN_PREFIX.length)
      .replaceAll("-", "+")
      .replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    return new TextDecoder().decode(bytes) || null;
  } catch {
    return null;
  }
}
