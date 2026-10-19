import { TZDate } from "@date-fns/tz";
import { subDays, subMonths, subYears } from "date-fns";
import {
  parseSearchQuery,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";

export const MAX_SEARCH_QUERY_LENGTH = 300;
export const MAX_GENERATED_SEARCHES = 3;

type SearchSyntax = "google" | "microsoft";

const MIN_NATURAL_LANGUAGE_WORDS = 3;
// Question marks across scripts: Latin, full-width (CJK), Arabic, and the
// Spanish opening mark.
const QUESTION_MARK = /[?？؟]\s*$|¿/;
const SEARCH_SYNTAX_CHARACTERS = /["(){}]/;
// The Gmail API reads after:/before: dates as midnight Pacific time.
const GMAIL_QUERY_TIME_ZONE = "America/Los_Angeles";

// What widening drops: conditions that narrow a search beyond who it's
// with and what it says.
const NARROWING_OPERATORS = new Set([
  "after",
  "before",
  "older_than",
  "newer_than",
  "received",
  "has",
  "hasattachment",
  "hasattachments",
  "label",
  "category",
  "is",
  "in",
]);
const PEOPLE_OPERATORS = new Set(["from", "to"]);

/**
 * Whether a committed search reads as a sentence rather than keywords or
 * operators, so it's worth a model call to understand. Structural only, so it
 * works in any language: anything written in search syntax (operators, OR,
 * negation, quotes, brackets) is left as typed, a question always counts, and
 * otherwise it takes a few words.
 */
export function looksLikeNaturalLanguage(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > MAX_SEARCH_QUERY_LENGTH) return false;
  if (SEARCH_SYNTAX_CHARACTERS.test(trimmed)) return false;
  if (usesSearchSyntax(parseSearchQuery(trimmed))) return false;
  if (QUESTION_MARK.test(trimmed)) return true;
  return countWords(trimmed) >= MIN_NATURAL_LANGUAGE_WORDS;
}

/**
 * Keeps only what Cue can run of a search a model wrote: the operators below,
 * with valid values, in the account provider's syntax. Labels the account
 * doesn't have, dates that can't match and unknown operators are dropped
 * rather than searched for. Null when nothing searchable is left.
 */
export function cleanGeneratedSearch(
  query: string,
  {
    now,
    provider,
    labelNames,
  }: {
    now: Date;
    provider: SearchSyntax;
    /** The account's labels (Outlook: categories); a label not here is dropped. */
    labelNames: string[];
  },
): string | null {
  const trimmed = query.trim().slice(0, MAX_SEARCH_QUERY_LENGTH);
  if (!trimmed) return null;
  const labels = new Map(
    labelNames.map((name) => [labelQueryName(name), name] as const),
  );
  const cleaned = cleanNode(parseSearchQuery(trimmed), {
    now,
    provider,
    labels,
  });
  if (!cleaned) return null;
  const consistent = dropImpossibleDates(cleaned, provider);
  if (!consistent || !hasPositiveTerm(consistent)) return null;
  return formatSearchNode(consistent);
}

/**
 * One wider version of a search that found too little: first drop the
 * dates, attachment, label and folder conditions; if it had none, accept any
 * of its words instead of all of them, or, beside a sender, just the sender.
 * Null when the search can't get wider.
 */
export function widenSearch(query: string): string | null {
  const ast = parseSearchQuery(query.trim());
  const original = formatSearchNode(ast);
  const stripped = stripNarrowing(ast);
  if (stripped) {
    const formatted = formatSearchNode(stripped);
    if (formatted !== original && hasPositiveTerm(stripped)) return formatted;
  }
  const broader = broadenTerms(stripped ?? ast);
  return broader ? formatSearchNode(broader) : null;
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
      // OR binds tighter than the implicit AND, so an OR of single terms
      // needs no brackets.
      return node.children
        .map((child) =>
          child.kind === "or" && !child.children.every(isLeaf)
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

type CleanContext = {
  now: Date;
  provider: SearchSyntax;
  labels: Map<string, string>;
};

function cleanNode(node: SearchNode, context: CleanContext): SearchNode | null {
  switch (node.kind) {
    case "text": {
      const value = node.value.trim();
      return value ? { ...node, value } : null;
    }
    case "around":
      return null;
    case "not": {
      // Only a single word or person can be left out; Outlook can't negate
      // a group.
      if (!isLeaf(node.child)) return null;
      const child = cleanNode(node.child, context);
      if (!child || child.kind !== node.child.kind) return null;
      if (child.kind === "operator" && !PEOPLE_OPERATORS.has(child.name))
        return null;
      return { kind: "not", child };
    }
    case "and":
    case "or": {
      const children = node.children.flatMap((child) => {
        const cleaned = cleanNode(child, context);
        return cleaned ? [cleaned] : [];
      });
      if (!children.length) return null;
      if (children.length === 1) return children[0];
      return { kind: node.kind, children };
    }
    case "operator":
      return cleanOperator(node, context);
  }
}

function cleanOperator(
  node: Extract<SearchNode, { kind: "operator" }>,
  { now, provider, labels }: CleanContext,
): SearchNode | null {
  const value = node.value.trim();
  if (!value) return null;
  const lower = value.toLowerCase();
  const operator = (name: string, operatorValue: string): SearchNode => ({
    kind: "operator",
    name,
    comparator: ":",
    value: operatorValue,
    quoted: /\s/.test(operatorValue),
  });
  if (node.comparator !== ":") return null;
  switch (node.name) {
    case "from":
    case "to":
    case "subject":
      return operator(node.name, value);
    case "label": {
      const name = labels.get(labelQueryName(value));
      if (!name) return null;
      return operator(provider === "microsoft" ? "category" : "label", name);
    }
    case "has":
      if (lower !== "attachment") return null;
      return provider === "microsoft"
        ? operator("hasattachments", "true")
        : operator("has", "attachment");
    case "is":
      if (lower === "starred" || lower === "flagged")
        return operator("is", provider === "microsoft" ? "flagged" : "starred");
      if (
        provider === "google" &&
        (lower === "unread" || lower === "important")
      )
        return operator("is", lower);
      return null;
    case "in":
      return lower === "inbox" || lower === "sent"
        ? operator("in", lower)
        : null;
    case "after":
    case "before":
    case "newer_than":
    case "older_than": {
      const day = node.name.endsWith("_than")
        ? relativeDay(lower, now)
        : parseDay(value);
      if (!day) return null;
      const isAfter = node.name === "after" || node.name === "newer_than";
      // A search for mail from the future finds nothing.
      if (isAfter && dayStartMs(day) > now.getTime()) return null;
      return dateOperator(isAfter ? "after" : "before", day, provider);
    }
    default:
      return null;
  }
}

type Day = { year: number; month: number; day: number };

/**
 * An after: and before: pair that leaves no day between them would find
 * nothing, so both go. Only the top level is checked, which is where a
 * generated date range sits.
 */
function dropImpossibleDates(
  node: SearchNode,
  provider: SearchSyntax,
): SearchNode | null {
  if (node.kind !== "and") return node;
  const bounds = node.children.map((child) => dateBound(child, provider));
  const afters = bounds.flatMap((b) => (b?.kind === "after" ? [b.ms] : []));
  const befores = bounds.flatMap((b) => (b?.kind === "before" ? [b.ms] : []));
  if (!afters.length || !befores.length) return node;
  if (Math.max(...afters) < Math.min(...befores)) return node;
  const children = node.children.filter((_, index) => !bounds[index]);
  if (!children.length) return null;
  return children.length === 1 ? children[0] : { kind: "and", children };
}

function dateBound(
  node: SearchNode,
  provider: SearchSyntax,
): { kind: "after" | "before"; ms: number } | null {
  if (node.kind !== "operator") return null;
  if (provider === "microsoft") {
    if (node.name !== "received") return null;
    const day = parseDay(node.value);
    if (!day) return null;
    return {
      kind: node.comparator === "<" ? "before" : "after",
      ms: dayStartMs(day),
    };
  }
  if (node.name !== "after" && node.name !== "before") return null;
  const day = parseDay(node.value);
  return day ? { kind: node.name, ms: dayStartMs(day) } : null;
}

function dateOperator(
  kind: "after" | "before",
  { year, month, day }: Day,
  provider: SearchSyntax,
): SearchNode {
  const pad = (n: number) => String(n).padStart(2, "0");
  if (provider === "microsoft") {
    return {
      kind: "operator",
      name: "received",
      comparator: kind === "after" ? ">=" : "<",
      value: `${year}-${pad(month)}-${pad(day)}`,
      quoted: false,
    };
  }
  return {
    kind: "operator",
    name: kind,
    comparator: ":",
    value: `${year}/${pad(month)}/${pad(day)}`,
    quoted: false,
  };
}

function parseDay(value: string): Day | null {
  const match = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    return null;
  return { year, month, day };
}

function relativeDay(value: string, now: Date): Day | null {
  const match = value.match(/^(\d{1,4})([dmy])$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const subtract = { d: subDays, m: subMonths, y: subYears }[
    match[2] as "d" | "m" | "y"
  ];
  const date = subtract(now, amount);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function dayStartMs({ year, month, day }: Day) {
  return new TZDate(year, month - 1, day, GMAIL_QUERY_TIME_ZONE).getTime();
}

function stripNarrowing(node: SearchNode): SearchNode | null {
  switch (node.kind) {
    case "operator":
      if (NARROWING_OPERATORS.has(node.name)) return null;
      if (node.name === "subject" || node.name === "body")
        return { kind: "text", value: node.value, exact: node.quoted };
      return node;
    case "not":
      return null;
    case "and":
    case "or": {
      const children = node.children.flatMap((child) => {
        const stripped = stripNarrowing(child);
        return stripped ? [stripped] : [];
      });
      if (!children.length) return null;
      if (children.length === 1) return children[0];
      return { kind: node.kind, children };
    }
    default:
      return node;
  }
}

function broadenTerms(node: SearchNode): SearchNode | null {
  if (node.kind !== "and") return null;
  const people = node.children.filter(
    (child) => child.kind === "operator" && PEOPLE_OPERATORS.has(child.name),
  );
  const terms = node.children.filter((child) => !people.includes(child));
  if (people.length && terms.length)
    return people.length === 1 ? people[0] : { kind: "and", children: people };
  if (terms.length < 2) return null;
  return {
    kind: "or",
    children: terms.flatMap((term) =>
      term.kind === "or" ? term.children : [term],
    ),
  };
}

function hasPositiveTerm(node: SearchNode): boolean {
  switch (node.kind) {
    case "not":
      return false;
    case "and":
    case "or":
      return node.children.some(hasPositiveTerm);
    default:
      return true;
  }
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

function isLeaf(node: SearchNode) {
  return node.kind === "text" || node.kind === "operator";
}

function formatValue(value: string, quoted: boolean) {
  return quoted || /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}

// Gmail writes a label's spaces and slashes as hyphens in a query.
function labelQueryName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s/-]+/g, "-");
}
