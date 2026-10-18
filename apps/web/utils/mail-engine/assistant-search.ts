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
} & AssistantSearchSyntax;

/**
 * How to read the query. A Gmail query carries everything; an Outlook search
 * is the KQL Graph would receive plus the tool's structured sender and read
 * state, which Graph applies as filters next to the KQL.
 */
export type AssistantSearchSyntax =
  | { syntax?: "gmail" }
  | {
      syntax: "outlook";
      fromEmail?: string;
      readState?: "read" | "unread";
    };

type LocalSearch = { predicate: MailPredicate; fromAddress: string | null };

/**
 * Answers one search the assistant asked this tab for and sends the answer
 * back, including "unavailable", so the assistant searches the provider at
 * once instead of waiting out its timeout.
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
  // Only the fields a search needs: the request arrives over the reply
  // stream and must not choose the account, store or timeout.
  const syntax: AssistantSearchSyntax =
    request.syntax === "outlook"
      ? {
          syntax: "outlook",
          fromEmail: request.fromEmail,
          readState: request.readState,
        }
      : { syntax: "gmail" };
  const result: LocalMailSearchResult = client
    ? await searchLocalMail({
        client,
        accountId,
        query: request.query,
        limit: request.limit,
        pageToken: request.pageToken,
        ...syntax,
      }).catch(() => ({ status: "unavailable", reason: "error" }) as const)
    : { status: "unavailable", reason: "no_engine" };
  // An answer the server would reject is worth less than a quick handback.
  const accepted = localMailSearchResultSchema.safeParse(result).success
    ? result
    : ({ status: "unavailable", reason: "error" } as const);
  await submit({ requestId: request.requestId, result: accepted });
}

/**
 * Answers the assistant's Gmail or Outlook search from the mail already in
 * the local store, in the shape the server's search returns: matching
 * messages, each with its own fields, newest first, `limit` counting
 * messages. Says `unavailable` (and the server searches the provider instead)
 * for a query it can't answer exactly, before the mailbox has fully synced,
 * or for word searches before bodies are indexed, so a local answer is never
 * a partial one.
 */
export async function searchLocalMail({
  client,
  accountId,
  query,
  limit,
  pageToken,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  ...syntax
}: {
  client: MailClient;
  accountId: string;
  query: string;
  limit: number;
  pageToken?: string | null;
  now?: Date;
  /** The user's time zone, which Outlook's whole-day dates are read in. */
  timeZone?: string;
  timeoutMs?: number;
} & AssistantSearchSyntax): Promise<LocalMailSearchResult> {
  if (!client.searchMessages)
    return { status: "unavailable", reason: "no_engine" };
  const search =
    syntax.syntax === "outlook"
      ? outlookQueryToLocalSearch({
          query,
          fromEmail: syntax.fromEmail,
          readState: syntax.readState,
          timeZone,
        })
      : gmailQueryToLocalSearch(query, now);
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
  if (
    !isComplete(coverage, "metadata") ||
    !withinSyncedWindow(coverage, search.predicate)
  )
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

// Chat's Outlook search leaves out Junk Email and Deleted Items, as Gmail's
// leaves out spam and trash (the server asks Graph for `excludeSpamTrash`),
// and drafts, which the server drops from Graph's answer. Outlook sync never
// stores those folders, so this only matters for mail just moved there in Cue.
const OUTLOOK_SEARCH_SCOPE: MailPredicate = {
  kind: "all",
  predicates: [
    { kind: "mailbox", mailbox: "all" },
    { kind: "not", predicate: { kind: "role", role: "draft" } },
  ],
};

/**
 * The local search for an Outlook search, or null when any part of it has
 * Graph semantics the local store can't reproduce exactly. `query` is the
 * KQL exactly as Graph receives it: free text inside Graph's $search quotes,
 * or a single field restriction. Words match by prefix in the subject, sender
 * and body, as Graph's default search fields do. Recipients, partial sender
 * names, NOT, grouping, mixed AND/OR, categories and folders stay with Graph.
 */
export function outlookQueryToLocalSearch({
  query,
  fromEmail,
  readState,
  timeZone,
}: {
  query: string;
  fromEmail?: string;
  readState?: "read" | "unread";
  timeZone: string;
}): LocalSearch | null {
  let fromAddress = fromEmail ? fromEmail.toLowerCase() : null;
  if (fromAddress && !isWholeAddress(fromAddress)) return null;
  const clauses: MailPredicate[] = [];

  const kql = unwrapGraphSearch(query.trim());
  if (kql === null) return null;
  if (kql) {
    const parsed = parseKql(kql, timeZone);
    if (!parsed) return null;
    if (parsed.fromAddress) {
      if (fromAddress && fromAddress !== parsed.fromAddress) return null;
      fromAddress = parsed.fromAddress;
    }
    clauses.push(...parsed.clauses);
  }
  if (readState) clauses.push({ kind: "read", value: readState === "read" });
  if (!clauses.length && !fromAddress) return null;

  return {
    predicate: { kind: "all", predicates: [OUTLOOK_SEARCH_SCOPE, ...clauses] },
    fromAddress,
  };
}

// Free text reaches Graph wrapped in $search quotes with its own quotes
// removed; a field restriction reaches it bare. Escapes stay with Graph.
function unwrapGraphSearch(query: string): string | null {
  if (query.includes("\\")) return null;
  if (!query.startsWith('"')) return query;
  const inner = query.slice(1, -1);
  if (query.length < 2 || !query.endsWith('"') || inner.includes('"'))
    return null;
  return inner.trim();
}

type KqlItem =
  | { kind: "word"; value: string }
  | { kind: "from"; address: string }
  | { kind: "clause"; predicate: MailPredicate };

function parseKql(
  kql: string,
  timeZone: string,
): { clauses: MailPredicate[]; fromAddress: string | null } | null {
  const tokenPattern = /(?:[^\s"]+|"[^"]*")+/g;
  // An unclosed quote is left over by the tokenizer.
  if (kql.replace(tokenPattern, "").trim()) return null;
  const tokens = kql.match(tokenPattern) ?? [];
  const items: KqlItem[] = [];
  const connectors = new Set<string>();
  let expectClause = true;

  for (const token of tokens) {
    if (token === "OR" || token === "AND") {
      if (expectClause) return null;
      connectors.add(token);
      expectClause = true;
      continue;
    }
    // Two clauses side by side are an implicit AND.
    if (!expectClause) connectors.add("AND");
    const item = kqlItem(token, timeZone);
    if (!item) return null;
    items.push(item);
    expectClause = false;
  }
  if (expectClause || connectors.size > 1) return null;

  if (connectors.has("OR")) {
    const alternatives: MailPredicate[] = [];
    for (const item of items) {
      // The sender is a filter on the whole search, not one alternative.
      if (item.kind === "from") return null;
      alternatives.push(
        item.kind === "word" ? wordsClause([item.value]) : item.predicate,
      );
    }
    return {
      clauses: [{ kind: "any", predicates: alternatives }],
      fromAddress: null,
    };
  }

  const senders = new Set(
    items.flatMap((item) => (item.kind === "from" ? [item.address] : [])),
  );
  if (senders.size > 1) return null;
  const words = items.flatMap((item) =>
    item.kind === "word" ? [item.value] : [],
  );
  return {
    clauses: [
      ...items.flatMap((item) =>
        item.kind === "clause" ? [item.predicate] : [],
      ),
      ...(words.length ? [wordsClause(words)] : []),
    ],
    fromAddress: [...senders][0] ?? null,
  };
}

function kqlItem(token: string, timeZone: string): KqlItem | null {
  const received = token.match(
    /^received(>=|<=|>|<|=|:)(\d{4})-(\d{2})-(\d{2})$/i,
  );
  if (received) {
    const [operator, ...date] = received.slice(1);
    const predicate = receivedClause(operator, date.map(Number), timeZone);
    return predicate && { kind: "clause", predicate };
  }

  const field = token.match(/^([a-z]+):(.+)$/i);
  if (!field) {
    // KQL's operators in another case, or NOT and NEAR, aren't read the same
    // way locally.
    if (/^(?:and|or|not|near|onear)$/i.test(token)) return null;
    return isWord(token) ? { kind: "word", value: token } : null;
  }
  const name = field[1].toLowerCase();
  const rawValue = field[2];
  const quoted = rawValue.length > 1 && /^".*"$/.test(rawValue);
  const value = quoted ? rawValue.slice(1, -1).trim() : rawValue;
  if (!value || (!quoted && rawValue.includes('"'))) return null;

  switch (name) {
    case "subject":
    case "body": {
      if (!quoted && !isWord(value)) return null;
      return {
        kind: "clause",
        predicate: {
          kind: "text",
          field: name,
          value,
          match: quoted ? "phrase" : "term",
        },
      };
    }
    // Graph also matches partial names and addresses; only one whole
    // address means the same thing locally.
    case "from":
      return isWholeAddress(value)
        ? { kind: "from", address: value.toLowerCase() }
        : null;
    case "hasattachment":
    case "hasattachments": {
      const flag = value.toLowerCase();
      if (flag !== "true" && flag !== "false") return null;
      return {
        kind: "clause",
        predicate: { kind: "has_attachment", value: flag === "true" },
      };
    }
    default:
      return null;
  }
}

// KQL compares a date without a time as the whole day.
function receivedClause(
  operator: string,
  [year, month, day]: number[],
  timeZone: string,
): MailPredicate | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const start = new TZDate(year, month - 1, day, timeZone).getTime();
  const end = new TZDate(year, month - 1, day + 1, timeZone).getTime();
  const ranges: Record<string, [number | null, number | null]> = {
    ">=": [start, null],
    ">": [end, null],
    "<": [null, start],
    "<=": [null, end],
    "=": [start, end],
    ":": [start, end],
  };
  const range = ranges[operator];
  if (!range) return null;
  return { kind: "received", afterMs: range[0], beforeMs: range[1] };
}

function wordsClause(words: string[]): MailPredicate {
  return { kind: "text", field: "any", value: words.join(" "), match: "term" };
}

function isWord(value: string) {
  return /^[\p{L}\p{N}][\p{L}\p{N}@._'-]*$/u.test(value);
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

// A first sync can keep only recent mail (Gmail's last 30 days), so a search
// is answered locally only when it asks for nothing older than that.
function withinSyncedWindow(
  coverage: Coverage[],
  predicate: MailPredicate,
): boolean {
  const windowStartMs = Math.max(
    ...coverage.map((item) => item.windowStartMs ?? Number.NEGATIVE_INFINITY),
  );
  if (windowStartMs === Number.NEGATIVE_INFINITY) return true;
  const clauses = predicate.kind === "all" ? predicate.predicates : [predicate];
  return clauses.some(
    (clause) =>
      clause.kind === "received" &&
      clause.afterMs !== null &&
      clause.afterMs >= windowStartMs,
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
