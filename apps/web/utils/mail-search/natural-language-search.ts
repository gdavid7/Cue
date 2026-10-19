import {
  parseSearchQuery,
  type SearchNode,
} from "@/utils/mail-search/parse-search-query";

export const MAX_SEARCH_QUERY_LENGTH = 300;
export const MAX_GENERATED_SEARCHES = 3;

const MIN_NATURAL_LANGUAGE_WORDS = 3;
const MIN_QUESTION_WORDS = 2;
// Question marks across scripts: Latin, full-width (CJK), Arabic, and the
// Spanish opening mark.
const QUESTION_MARK = /[?？؟]\s*$|¿/;
const SEARCH_SYNTAX_CHARACTERS = /["(){}]/;

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
      // Bracketed so alternatives read as one group. An OR of operators
      // stays bare: Outlook can't read a bracket before an operator, and OR
      // binding tighter than the implicit AND gives the same search.
      return node.children
        .map((child) =>
          child.kind === "or" &&
          !child.children.every((leaf) => leaf.kind === "operator")
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

function formatValue(value: string, quoted: boolean) {
  return quoted || /\s/.test(value) ? `"${value.replace(/"/g, "")}"` : value;
}
