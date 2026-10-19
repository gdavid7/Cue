import { TZDate } from "@date-fns/tz";
import { subDays, subMonths, subYears } from "date-fns";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import {
  parseSearchQuery,
  type SearchComparator,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";
import { parseBooleanSearchValue } from "@/utils/tokenize-search-query";

export type SearchLabel = { id: string; name: string };

export type SearchQueryContext = {
  now: Date;
  /**
   * The account's own labels (Outlook: categories), for `label:Name`. Left
   * out, a label named by its name is matched by the provider alone.
   */
  labels?: SearchLabel[];
  /** The user's time zone, which Outlook's whole-day dates are read in. */
  timeZone?: string;
  /**
   * Whose syntax the query is in. Left out (a view across accounts), both
   * Gmail's operators and the KQL Cue's Outlook form writes are read.
   */
  provider?: "google" | "microsoft";
};

// The Gmail API reads after:/before: dates as midnight Pacific time, so the
// store does too and both halves of a search agree on the day's edges.
const GMAIL_QUERY_TIME_ZONE = "America/Los_Angeles";

// Outlook's KQL, which Gmail reads as words.
const KQL_OPERATORS = new Set([
  "hasattachment",
  "hasattachments",
  "received",
  "sent",
  "folder",
  "body",
  "participants",
  "importance",
  "attachment",
  "attachments",
  "kind",
]);

// The schema allows this many children per all/any.
const MAX_CHILDREN = 32;

const TRUE: MailPredicate = { kind: "all", predicates: [] };
const FALSE: MailPredicate = { kind: "any", predicates: [] };

/**
 * The predicate for a search typed in the search box: a `search` the engine
 * also hands to the provider verbatim, inside Gmail's default scope, which
 * leaves out spam and trash unless the query asks for them. Null when the
 * query has nothing to search for.
 */
export function searchQueryToPredicate(
  query: string,
  context: SearchQueryContext,
  /** Limits the search to these accounts, all of `context.provider`. */
  accountIds?: string[],
): MailPredicate | null {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const ast = parseSearchQuery(trimmed);
  if (ast.kind === "and" && ast.children.length === 0) return null;
  const search: MailPredicate = {
    kind: "search",
    query: trimmed,
    local: compileSearchNode(ast, context),
    possible: compile(ast, context, "over", true),
    ...(accountIds ? { accountIds } : {}),
  };
  if (reachesSpamOrTrash(ast, context.provider)) return search;
  return {
    kind: "all",
    predicates: [search, { kind: "mailbox", mailbox: "all" }],
  };
}

/**
 * A search across accounts, each read in its own provider's syntax: a Gmail
 * account never filters by Outlook's KQL, and each provider's own spam and
 * trash tokens widen only its accounts. Accounts sharing a provider share one
 * search, so a view of one provider's accounts reads like a single account.
 */
export function searchQueryForAccounts(
  query: string,
  context: Omit<SearchQueryContext, "provider" | "labels">,
  accounts: Array<{ id: string; provider: string }>,
): MailPredicate | null {
  const groups = new Map<SearchQueryContext["provider"], string[]>();
  for (const account of accounts) {
    const provider = searchProvider(account.provider);
    groups.set(provider, [...(groups.get(provider) ?? []), account.id]);
  }
  if (groups.size <= 1) {
    const [provider] = groups.keys();
    return searchQueryToPredicate(query, { ...context, provider });
  }
  const predicates = [...groups].flatMap(([provider, accountIds]) => {
    const predicate = searchQueryToPredicate(
      query,
      { ...context, provider },
      accountIds,
    );
    return predicate ? [predicate] : [];
  });
  return predicates.length ? anyOf(predicates) : null;
}

/** The syntax an account's provider reads, when it is one Cue knows. */
export function searchProvider(
  provider: string | null | undefined,
): SearchQueryContext["provider"] {
  return provider === "google" || provider === "microsoft"
    ? provider
    : undefined;
}

/**
 * What the store can answer of `node` by itself. Where the store can't
 * evaluate a condition (sizes, filenames, Drive links, mailing lists...), the
 * condition counts as unmatched, or as matched under a negation, so the
 * local result never holds a message the whole query wouldn't match; the
 * provider's search for the query finds those messages instead.
 */
export function compileSearchNode(
  node: SearchNode,
  context: SearchQueryContext,
): MailPredicate {
  return compile(node, context, "under", false);
}

/**
 * Whether a predicate holds a typed search the local mail can't answer any
 * of (`larger:5M`), so only the provider can find its mail.
 */
export function searchNeedsProvider(predicate: MailPredicate): boolean {
  switch (predicate.kind) {
    case "search":
      return (
        predicate.local.kind === "any" && !predicate.local.predicates.length
      );
    case "all":
    case "any":
      return predicate.predicates.some(searchNeedsProvider);
    case "not":
      return searchNeedsProvider(predicate.predicate);
    default:
      return false;
  }
}

/**
 * Whether a search reaches spam and trash, which Gmail's search (and Cue's)
 * leaves out unless the query names them. Only a token the provider reads
 * counts, and only where it isn't negated: `-in:trash` still leaves spam out.
 */
export function searchReachesSpamOrTrash(
  query: string,
  provider?: SearchQueryContext["provider"],
): boolean {
  return reachesSpamOrTrash(parseSearchQuery(query), provider);
}

/** Maps a Gmail label or system token to the store's predicate for it. */
export function gmailTokenToPredicate(id: string): MailPredicate {
  if (id === "INBOX") return { kind: "role", role: "inbox" };
  if (id === "SENT") return { kind: "role", role: "sent" };
  if (id === "DRAFT") return { kind: "role", role: "draft" };
  if (id === "TRASH") return { kind: "role", role: "trash" };
  if (id === "SPAM") return { kind: "role", role: "spam" };
  if (id === "UNREAD") return { kind: "read", value: false };
  if (id === "STARRED") return { kind: "starred", value: true };
  if (id.startsWith("CATEGORY_")) {
    return { kind: "membership", membership: "category", id };
  }
  return { kind: "membership", membership: "label", id };
}

// "under" never matches more than the query, "over" never matches less; a
// negation swaps them so each stays what it is.
type Bound = "under" | "over";

// Conditions the provider may answer differently from the store: words (it
// stems, and reads bodies and attachments the store may not hold),
// attachments (it counts some inline parts the store doesn't), and snoozing
// (Gmail's own snooze, which Cue's isn't).
function providerJudges(leaf: MailPredicate) {
  if (leaf.kind === "text" || leaf.kind === "has_attachment") return true;
  return leaf.kind === "mailbox" && leaf.mailbox === "snoozed";
}

// `looseText` leaves what providerJudges names to the provider, for a bound
// that must not drop the provider's own matches.
function compile(
  node: SearchNode,
  context: SearchQueryContext,
  bound: Bound,
  looseText: boolean,
): MailPredicate {
  switch (node.kind) {
    case "and":
      return allOf(
        mergeWords(node.children).map((child) =>
          compile(child, context, bound, looseText),
        ),
      );
    case "or":
      return anyOf(
        node.children.map((child) => compile(child, context, bound, looseText)),
      );
    case "not": {
      const inner = compile(node.child, context, flip(bound), looseText);
      if (inner === TRUE) return FALSE;
      if (inner === FALSE) return TRUE;
      return { kind: "not", predicate: inner };
    }
    default: {
      const leaf = leafPredicate(node, context);
      if (leaf && !(looseText && providerJudges(leaf))) return leaf;
      return bound === "under" ? FALSE : TRUE;
    }
  }
}

// Adjacent words become one text condition, the shape the store's index
// answers fastest.
function mergeWords(children: SearchNode[]): SearchNode[] {
  const words = children.flatMap((child) =>
    child.kind === "text" && !child.exact ? [child.value] : [],
  );
  if (words.length < 2) return children;
  return [
    { kind: "text", value: words.join(" "), exact: false },
    ...children.filter((child) => !(child.kind === "text" && !child.exact)),
  ];
}

function leafPredicate(
  node: Exclude<SearchNode, { kind: "and" | "or" | "not" }>,
  context: SearchQueryContext,
): MailPredicate | null {
  if (node.kind === "around") return null;
  if (node.kind === "text") {
    // The one place the store can match more than Gmail: it reads each word
    // as a prefix, as the search box does while typing (see search-text.ts
    // in mail-sqlite), where Gmail matches whole words.
    return {
      kind: "text",
      field: "any",
      value: node.value,
      match: node.exact ? "phrase" : "term",
    };
  }
  const { name, comparator, value, quoted } = node;
  if (!value) return null;
  // To Gmail these are just words.
  if (
    context.provider === "google" &&
    (KQL_OPERATORS.has(name) || (name === "size" && comparator !== ":"))
  ) {
    return {
      kind: "text",
      field: "any",
      value: `${name}${comparator}${value}`,
      match: quoted ? "phrase" : "term",
    };
  }
  if (name === "received") return receivedPredicate(comparator, value, context);
  if (comparator !== ":") return null;
  const lower = value.toLowerCase();
  switch (name) {
    case "from":
    case "cc":
    case "bcc":
      // "me" is the account's own addresses, which the store doesn't know.
      if (lower === "me") return null;
      return { kind: "address", field: name, value, match: "address" };
    case "to":
      if (lower === "me") return null;
      // Gmail's to: matches every recipient, Cc and Bcc included.
      return anyOf(
        (["to", "cc", "bcc"] as const).map((field) => ({
          kind: "address",
          field,
          value,
          match: "address",
        })),
      );
    case "subject":
    case "body":
      return {
        kind: "text",
        field: name,
        value,
        match: quoted ? "phrase" : "term",
      };
    case "has":
      return lower === "attachment"
        ? { kind: "has_attachment", value: true }
        : null;
    case "hasattachment":
    case "hasattachments": {
      const flag = parseBooleanSearchValue(value);
      if (flag !== undefined) return { kind: "has_attachment", value: flag };
      // Not Gmail's operator, and no flag Outlook reads: just words.
      return {
        kind: "text",
        field: "any",
        value: `${name}:${value}`,
        match: "term",
      };
    }
    case "is":
      return isPredicate(lower);
    case "in":
      return inPredicate(lower) ?? labelPredicate(value, context.labels);
    case "label":
      return labelPredicate(value, context.labels);
    case "category":
      return (
        categoryPredicate(lower) ??
        // Outlook's categories are its labels.
        labelPredicate(value, context.labels)
      );
    case "after":
    case "newer":
    case "before":
    case "older": {
      const at = gmailDateMs(value);
      if (at === null) return null;
      return name === "after" || name === "newer"
        ? { kind: "received", afterMs: at, beforeMs: null }
        : { kind: "received", afterMs: null, beforeMs: at };
    }
    case "newer_than":
    case "older_than": {
      const at = relativeAgeMs(lower, context.now);
      if (at === null) return null;
      return name === "newer_than"
        ? { kind: "received", afterMs: at, beforeMs: null }
        : { kind: "received", afterMs: null, beforeMs: at };
    }
    default:
      return null;
  }
}

function isPredicate(value: string): MailPredicate | null {
  switch (value) {
    case "unread":
      return { kind: "read", value: false };
    case "read":
      return { kind: "read", value: true };
    case "starred":
    case "flagged":
      return { kind: "starred", value: true };
    case "important":
      return gmailTokenToPredicate("IMPORTANT");
    case "snoozed":
      return { kind: "mailbox", mailbox: "snoozed" };
    // Cue keeps no chats.
    case "chat":
      return FALSE;
    default:
      return null;
  }
}

function inPredicate(value: string): MailPredicate | null {
  switch (value) {
    case "inbox":
      return { kind: "mailbox", mailbox: "inbox" };
    case "sent":
    case "sentitems":
      return { kind: "mailbox", mailbox: "sent" };
    case "drafts":
    case "draft":
      return { kind: "mailbox", mailbox: "drafts" };
    case "spam":
    case "junk":
    case "junkemail":
      return { kind: "mailbox", mailbox: "spam" };
    case "trash":
    case "bin":
    case "deleted":
    case "deleteditems":
      return { kind: "mailbox", mailbox: "trash" };
    case "starred":
    case "flagged":
      return { kind: "mailbox", mailbox: "starred" };
    case "snoozed":
      return { kind: "mailbox", mailbox: "snoozed" };
    case "important":
      return gmailTokenToPredicate("IMPORTANT");
    case "archive":
      return { kind: "mailbox", mailbox: "archive" };
    case "anywhere":
      return TRUE;
    case "chats":
    case "chat":
      return FALSE;
    default:
      return null;
  }
}

function categoryPredicate(value: string): MailPredicate | null {
  const id = {
    primary: "CATEGORY_PERSONAL",
    personal: "CATEGORY_PERSONAL",
    social: "CATEGORY_SOCIAL",
    promotions: "CATEGORY_PROMOTIONS",
    updates: "CATEGORY_UPDATES",
    forums: "CATEGORY_FORUMS",
  }[value];
  return id ? gmailTokenToPredicate(id) : null;
}

const SYSTEM_LABELS = new Set([
  "INBOX",
  "SENT",
  "DRAFT",
  "SPAM",
  "TRASH",
  "UNREAD",
  "STARRED",
  "IMPORTANT",
]);

function labelPredicate(
  value: string,
  labels: SearchLabel[] | undefined,
): MailPredicate | null {
  const upper = value.toUpperCase();
  if (SYSTEM_LABELS.has(upper) || upper.startsWith("CATEGORY_"))
    return gmailTokenToPredicate(upper);
  if (upper === "DRAFTS") return gmailTokenToPredicate("DRAFT");
  if (!labels) return null;
  // Gmail writes a label's spaces and slashes as hyphens in a query.
  const wanted = labelQueryName(value);
  const ids = labels.flatMap((label) =>
    label.id === value || labelQueryName(label.name) === wanted
      ? [label.id]
      : [],
  );
  if (!ids.length) return null;
  return anyOf(ids.map(gmailTokenToPredicate));
}

function labelQueryName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "-");
}

function gmailDateMs(value: string): number | null {
  if (/^\d{9,11}$/.test(value)) return Number(value) * 1000;
  let parts = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/)?.slice(1);
  const monthFirst = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!parts && monthFirst) {
    parts = [monthFirst[3], monthFirst[1], monthFirst[2]];
  }
  if (!parts) return null;
  const [year, month, day] = parts.map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new TZDate(year, month - 1, day, GMAIL_QUERY_TIME_ZONE).getTime();
}

function relativeAgeMs(value: string, now: Date): number | null {
  const match = value.match(/^(\d{1,4})([dmy])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const subtract = { d: subDays, m: subMonths, y: subYears }[
    match[2] as "d" | "m" | "y"
  ];
  return subtract(now, amount).getTime();
}

// KQL compares a date without a time as the whole day.
function receivedPredicate(
  comparator: SearchComparator,
  value: string,
  context: SearchQueryContext,
): MailPredicate | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const timeZone =
    context.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const start = new TZDate(year, month - 1, day, timeZone).getTime();
  const end = new TZDate(year, month - 1, day + 1, timeZone).getTime();
  const ranges: Record<SearchComparator, [number | null, number | null]> = {
    ">=": [start, null],
    ">": [end, null],
    "<": [null, start],
    "<=": [null, end],
    "=": [start, end],
    ":": [start, end],
  };
  const [afterMs, beforeMs] = ranges[comparator];
  return { kind: "received", afterMs, beforeMs };
}

// The tokens each provider reads as reaching spam or trash. Outlook has no
// in:anywhere: its search covers the folders it is pointed at.
const SPAM_OR_TRASH_TOKENS = {
  google: /^(?:(?:in|label):(?:spam|trash)|in:anywhere)$/i,
  microsoft: /^in:(?:spam|junk|junkemail|trash|deleted|deleteditems)$/i,
};

function reachesSpamOrTrash(
  node: SearchNode,
  provider: SearchQueryContext["provider"],
): boolean {
  switch (node.kind) {
    case "and":
    case "or":
      return node.children.some((child) => reachesSpamOrTrash(child, provider));
    case "not":
      return false;
    case "operator":
      return (
        node.comparator === ":" &&
        SPAM_OR_TRASH_TOKENS[provider ?? "google"].test(
          `${node.name}:${node.value}`,
        )
      );
    default:
      return false;
  }
}

function flip(bound: Bound): Bound {
  return bound === "under" ? "over" : "under";
}

function allOf(predicates: MailPredicate[]): MailPredicate {
  if (predicates.includes(FALSE)) return FALSE;
  const kept = predicates.filter((predicate) => predicate !== TRUE);
  if (kept.length === 0) return TRUE;
  if (kept.length === 1) return kept[0];
  return { kind: "all", predicates: chunked(kept, "all") };
}

function anyOf(predicates: MailPredicate[]): MailPredicate {
  if (predicates.includes(TRUE)) return TRUE;
  const kept = predicates.filter((predicate) => predicate !== FALSE);
  if (kept.length === 0) return FALSE;
  if (kept.length === 1) return kept[0];
  return { kind: "any", predicates: chunked(kept, "any") };
}

function chunked(
  predicates: MailPredicate[],
  kind: "all" | "any",
): MailPredicate[] {
  if (predicates.length <= MAX_CHILDREN) return predicates;
  const chunks: MailPredicate[] = [];
  for (let index = 0; index < predicates.length; index += MAX_CHILDREN) {
    chunks.push({
      kind,
      predicates: predicates.slice(index, index + MAX_CHILDREN),
    });
  }
  return chunked(chunks, kind);
}
