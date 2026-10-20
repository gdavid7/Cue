import {
  parseSearchQuery,
  type SearchComparator,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";
import {
  compileSearchNode,
  type SearchQueryContext,
} from "@/utils/mail-search/search-query-predicate";

export const MAX_SEARCH_QUERY_LENGTH = 300;
export const MAX_GENERATED_SEARCHES = 3;

const MIN_NATURAL_LANGUAGE_WORDS = 3;
const MIN_QUESTION_WORDS = 2;
// Question marks across scripts: Latin, full-width (CJK), Arabic, and the
// Spanish opening mark.
const QUESTION_MARK = /[?？؟]\s*$|¿/;
const SEARCH_SYNTAX_CHARACTERS = /["(){}]/;

const DAY_MS = 24 * 60 * 60 * 1000;
// A widened window grows by its own length on each side, and at least this.
const MIN_DATE_PADDING_MS = 7 * DAY_MS;
// The searches one tier may run; the caller reads them together, in one query.
const MAX_TIER_SEARCHES = 6;

const PEOPLE_OPERATORS = new Set(["from", "to", "cc", "bcc"]);
const DATE_OPERATORS = new Set([
  "after",
  "before",
  "newer",
  "older",
  "newer_than",
  "older_than",
  "received",
]);
const WORD_OPERATORS = new Set(["subject", "body"]);

/**
 * What a part of a search narrows by: who the mail is with, one thing it
 * mentions (a word and its alternatives), when it arrived, or a condition
 * such as an attachment, a label or a folder.
 */
export type SearchClauseRole = "person" | "words" | "date" | "condition";
export type SearchClause = { node: SearchNode; role: SearchClauseRole };

/**
 * The tiers Cue widens a search through when it finds too little, in order:
 * the search less one of its word groups or conditions, then only who the
 * mail is with and when it arrived, then the same search over a wider window.
 */
export const WIDENING_TIERS = [
  "fewer_words",
  "sender_and_dates",
  "wider_dates",
] as const;
export type WideningTier = (typeof WIDENING_TIERS)[number];

/**
 * Whether a committed search reads as a sentence rather than keywords or
 * operators, so it's worth a model call to understand. Structural only, so it
 * works in any language: anything written in search syntax (operators, OR,
 * negation, quotes, brackets) is left as typed, a question takes two words,
 * and anything else three.
 */
export function looksLikeNaturalLanguage(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_SEARCH_QUERY_LENGTH) return false;
  if (SEARCH_SYNTAX_CHARACTERS.test(trimmed)) return false;
  if (usesSearchSyntax(parseSearchQuery(trimmed))) return false;
  const words = countWords(trimmed);
  if (QUESTION_MARK.test(trimmed)) return words >= MIN_QUESTION_WORDS;
  return words >= MIN_NATURAL_LANGUAGE_WORDS;
}

/**
 * The wider searches, by tier, for a search that found too little.
 * "fewer_words" is every way of leaving out one word group or condition, so
 * no part's importance has to be guessed; the ranking puts mail matching
 * more of the search first. A tier is empty when all it could search is
 * dates and conditions, or when it would repeat the search.
 */
export function widenSearchByTier(
  query: string,
  context: Pick<SearchQueryContext, "now" | "timeZone" | "provider">,
): Record<WideningTier, string[]> {
  const clauses = searchClauses(query);
  const original = formatClauses(clauses);
  const fewerWords = clauses.flatMap((clause, index) =>
    clause.role === "words" || clause.role === "condition"
      ? [clauses.filter((_, other) => other !== index)]
      : [],
  );
  const senderAndDates = clauses.some((clause) => clause.role === "person")
    ? [
        clauses.filter(
          (clause) => clause.role === "person" || clause.role === "date",
        ),
      ]
    : [];
  const widerDates = widenDates(clauses, context);
  const searches = (variants: SearchClause[][]) =>
    [
      ...new Set(
        variants
          .filter((variant) =>
            variant.some(
              (clause) => clause.role === "words" || clause.role === "person",
            ),
          )
          .map(formatClauses),
      ),
    ]
      .filter((search) => search !== original)
      .slice(0, MAX_TIER_SEARCHES);
  return {
    fewer_words: searches(fewerWords),
    sender_and_dates: searches(senderAndDates),
    wider_dates: searches(widerDates ? [widerDates] : []),
  };
}

/** A search's top-level parts, each with what it narrows by. */
export function searchClauses(query: string): SearchClause[] {
  const ast = parseSearchQuery(query.trim());
  const nodes = ast.kind === "and" ? ast.children : [ast];
  return nodes.map((node) => ({ node, role: clauseRole(node) }));
}

/** A search tree as query text, in the grammar parseSearchQuery reads. */
export function formatSearchNode(node: SearchNode): string {
  switch (node.kind) {
    case "text":
      return node.exact ? `"${node.value}"` : node.value;
    case "operator":
      return `${node.name}${node.comparator}${formatValue(node.value, node.quoted)}`;
    case "around":
      return node.text;
    case "not":
      return node.child.kind === "and" || node.child.kind === "or"
        ? `-(${formatSearchNode(node.child)})`
        : `-${formatSearchNode(node.child)}`;
    case "and":
      // Bracketed so alternatives read as one group, whichever binds
      // tighter in the provider's syntax.
      return node.children
        .map((child) =>
          child.kind === "or"
            ? `(${formatSearchNode(child)})`
            : formatSearchNode(child),
        )
        .join(" ");
    case "or":
      return node.children
        .map((child) =>
          child.kind === "and"
            ? `(${formatSearchNode(child)})`
            : formatSearchNode(child),
        )
        .join(" OR ");
  }
}

function clauseRole(node: SearchNode): SearchClauseRole {
  switch (node.kind) {
    case "operator":
      if (PEOPLE_OPERATORS.has(node.name)) return "person";
      if (DATE_OPERATORS.has(node.name)) return "date";
      if (WORD_OPERATORS.has(node.name)) return "words";
      return "condition";
    case "or":
      // A group of senders is people too, not words.
      return node.children.every(
        (child) =>
          child.kind === "operator" && PEOPLE_OPERATORS.has(child.name),
      )
        ? "person"
        : "words";
    case "not":
      return "condition";
    default:
      return "words";
  }
}

/**
 * The search with its dates replaced by a window grown by its own length on
 * each side, and ending no later than now. Null when it has no dates.
 */
function widenDates(
  clauses: SearchClause[],
  context: Pick<SearchQueryContext, "now" | "timeZone" | "provider">,
): SearchClause[] | null {
  let afterMs: number | null = null;
  let beforeMs: number | null = null;
  for (const clause of clauses) {
    if (clause.role !== "date") continue;
    const range = compileSearchNode(clause.node, context);
    if (range.kind !== "received") continue;
    if (range.afterMs !== null)
      afterMs = Math.max(afterMs ?? range.afterMs, range.afterMs);
    if (range.beforeMs !== null)
      beforeMs = Math.min(beforeMs ?? range.beforeMs, range.beforeMs);
  }
  if (afterMs === null && beforeMs === null) return null;
  const nowMs = context.now.getTime();
  const span = afterMs === null ? 0 : (beforeMs ?? nowMs) - afterMs;
  const padding = Math.max(span, MIN_DATE_PADDING_MS);
  const widerAfter = afterMs === null ? null : afterMs - padding;
  const widerBefore =
    beforeMs === null || beforeMs + padding >= nowMs
      ? null
      : beforeMs + padding;
  return [
    ...clauses.filter((clause) => clause.role !== "date"),
    ...dateNodes(widerAfter, widerBefore, context).map((node) => ({
      node,
      role: "date" as const,
    })),
  ];
}

/** A window in the syntax Cue's own searches for the provider use. */
function dateNodes(
  afterMs: number | null,
  beforeMs: number | null,
  { timeZone, provider }: Pick<SearchQueryContext, "timeZone" | "provider">,
): SearchNode[] {
  const node = (
    name: string,
    comparator: SearchComparator,
    value: string,
  ): SearchNode => ({
    kind: "operator",
    name,
    comparator,
    value,
    quoted: false,
  });
  const nodes: SearchNode[] = [];
  if (provider === "microsoft") {
    const day = (ms: number) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timeZone ?? "UTC",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(ms);
    if (afterMs !== null) nodes.push(node("received", ">=", day(afterMs)));
    if (beforeMs !== null) nodes.push(node("received", "<", day(beforeMs)));
    return nodes;
  }
  const seconds = (ms: number) => String(Math.floor(ms / 1000));
  if (afterMs !== null) nodes.push(node("after", ":", seconds(afterMs)));
  if (beforeMs !== null) nodes.push(node("before", ":", seconds(beforeMs)));
  return nodes;
}

function formatClauses(clauses: SearchClause[]): string {
  if (!clauses.length) return "";
  return formatSearchNode(
    clauses.length === 1
      ? clauses[0].node
      : { kind: "and", children: clauses.map((clause) => clause.node) },
  );
}

function usesSearchSyntax(node: SearchNode): boolean {
  switch (node.kind) {
    case "text":
      return node.exact;
    case "and":
      return node.children.some(usesSearchSyntax);
    default:
      return true;
  }
}

/**
 * Words, counted so that languages written without spaces count theirs too.
 * An address or link is one word.
 */
function countWords(text: string): number {
  const segmenter =
    typeof Intl !== "undefined" && "Segmenter" in Intl
      ? new Intl.Segmenter(undefined, { granularity: "word" })
      : null;
  let count = 0;
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    if (!segmenter || /[@/]/.test(token)) {
      count += 1;
      continue;
    }
    for (const segment of segmenter.segment(token)) {
      if (segment.isWordLike) count += 1;
    }
  }
  return count;
}

function formatValue(value: string, quoted: boolean) {
  return quoted || /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}
