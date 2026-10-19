import {
  parseBooleanSearchValue,
  tokenizeSearchQuery,
  unquoteSearchValue,
} from "@/utils/tokenize-search-query";
import { escapeSearchValue } from "@/utils/outlook/search-escape";
import type { WELL_KNOWN_FOLDERS } from "@/utils/outlook/constants";

export type OutlookWellKnownFolder = keyof typeof WELL_KNOWN_FOLDERS;

export type CompiledOutlookSearch = {
  /** Quoted Graph `$search` value, or empty when the query is filter-only. */
  search: string;
  folderKey?: OutlookWellKnownFolder;
  folderName?: string;
  flagged: boolean;
  category?: string;
};

type OutlookSearchToken = {
  excluded: boolean;
  field: string | null;
  comparator: ":" | ">" | ">=" | "<" | "<=" | null;
  value: string;
};

type OutlookSearchScope = {
  folderKey?: OutlookWellKnownFolder;
  folderName?: string;
  flagged: boolean;
  category?: string;
};

const FOLDER_KEY_BY_IN_VALUE: Record<string, OutlookWellKnownFolder> = {
  inbox: "inbox",
  sent: "sentitems",
  drafts: "drafts",
  archive: "archive",
  junk: "junkemail",
  spam: "junkemail",
  deleted: "deleteditems",
  trash: "deleteditems",
};

const KQL_TEXT_FIELDS = new Set(["from", "to", "subject"]);
const GROUP_OPEN = "(";
const GROUP_CLOSE = ")";
const NOT = "NOT";
const OR = "OR";
// Stands for `-(` until the brackets are known to pair up.
const NEGATED_GROUP = "\u0000-(";

/**
 * Compiles an Outlook search-box query into Graph `$search` KQL plus the
 * folder/flag/category scopes Graph cannot mix into `$search`.
 */
export function compileOutlookThreadSearch(
  query: string,
): CompiledOutlookSearch {
  const included: string[] = [];
  const excluded: string[] = [];
  const scope: OutlookSearchScope = { flagged: false };

  const tokens = splitGroupBrackets(tokenizeSearchQuery(query));
  let depth = 0;
  // Outside a group a negation can move to the end; inside one, or after an
  // OR, it stays in place, where the OR applies to it.
  const negate = (term: string) =>
    (depth > 0 || included.at(-1) === OR ? included : excluded).push(
      `${NOT} ${term}`,
    );
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token) continue;

    if (token === GROUP_OPEN || token === GROUP_CLOSE) {
      depth = Math.max(0, depth + (token === GROUP_OPEN ? 1 : -1));
      included.push(token);
      continue;
    }

    // KQL's operators are uppercase; a lowercase "not" is a word.
    if (token === NOT) {
      const next = tokens[index + 1];
      if (!next || next === GROUP_CLOSE) continue;
      // KQL negates a bracketed group as a whole.
      if (next === GROUP_OPEN) {
        included.push(NOT);
        continue;
      }
      const term = toKqlTerm(parseOutlookSearchToken(next));
      if (term) negate(term);
      index += 1;
      continue;
    }

    const parsed = parseOutlookSearchToken(token);
    if (applyOutlookSearchScope(parsed, scope)) continue;

    const term = toKqlTerm(parsed);
    if (!term) continue;
    if (parsed.excluded) negate(term);
    else included.push(term);
  }

  const { folderKey, folderName, flagged, category } = scope;
  tidyKqlTerms(included);

  if (!included.length && !excluded.length) {
    return { search: "", folderKey, folderName, flagged, category };
  }
  // KQL rejects purely negative queries, so anchor them to every message.
  if (!hasPositiveTerm(included)) included.unshift("size>=0");

  return {
    search: `"${[...included, ...excluded].join(" ")}"`,
    folderKey,
    folderName,
    flagged,
    category,
  };
}

export function isEmptyOutlookSearch(compiled: CompiledOutlookSearch): boolean {
  return (
    !compiled.search &&
    !compiled.folderKey &&
    !compiled.folderName &&
    !compiled.flagged &&
    !compiled.category
  );
}

export function parseOutlookSearchToken(token: string): OutlookSearchToken {
  const excluded = token.startsWith("-") && token.length > 1;
  const raw = excluded ? token.slice(1) : token;
  if (raw.startsWith('"')) {
    return {
      excluded,
      field: null,
      comparator: null,
      value: unquoteSearchValue(raw),
    };
  }

  const match = raw.match(/^([a-z]+)(>=|<=|>|<|:)(.*)$/i);
  if (!match || /^(https?|ftp|mailto|file)$/i.test(match[1])) {
    return {
      excluded,
      field: null,
      comparator: null,
      value: unquoteSearchValue(raw),
    };
  }

  return {
    excluded,
    field: match[1].toLowerCase(),
    comparator: match[2] as OutlookSearchToken["comparator"],
    value: unquoteSearchValue(match[3]),
  };
}

function applyOutlookSearchScope(
  parsed: OutlookSearchToken,
  scope: OutlookSearchScope,
): boolean {
  if (parsed.field === "in") {
    if (!parsed.excluded) {
      const key = FOLDER_KEY_BY_IN_VALUE[parsed.value.toLowerCase()];
      if (key && !scope.folderKey && !scope.folderName) scope.folderKey = key;
    }
    return true;
  }
  if (parsed.field === "folder") {
    if (
      !parsed.excluded &&
      parsed.value &&
      !scope.folderKey &&
      !scope.folderName
    ) {
      scope.folderName = parsed.value;
    }
    return true;
  }
  if (parsed.field === "is" && parsed.value.toLowerCase() === "flagged") {
    if (!parsed.excluded) scope.flagged = true;
    return true;
  }
  if (parsed.field === "category") {
    if (!parsed.excluded && parsed.value && !scope.category) {
      scope.category = parsed.value;
    }
    return true;
  }
  return false;
}

function toKqlTerm(parsed: OutlookSearchToken): string | null {
  const { field, comparator, value } = parsed;

  if (!field) return toKqlValue(value);

  if (KQL_TEXT_FIELDS.has(field)) {
    const kqlValue = toKqlValue(value);
    return kqlValue ? `${field}:${kqlValue}` : null;
  }

  if (field === "hasattachments" && parseBooleanSearchValue(value) === true) {
    return "hasattachments:true";
  }

  if (field === "size" && comparator && comparator !== ":") {
    const bytes = parseSizeBytes(value);
    if (bytes === null) return null;
    return `size${comparator}${bytes}`;
  }

  if (field === "received" && comparator && comparator !== ":") {
    const date = parseOutlookDate(value);
    if (!date) return null;
    return `received${comparator}${date}`;
  }

  // Unknown Outlook/KQL restrictions are passed through so typed queries like
  // importance:high still reach Graph.
  if (comparator === ":") {
    const kqlValue = toKqlValue(value);
    return kqlValue ? `${field}:${kqlValue}` : null;
  }

  return toKqlValue(value);
}

/**
 * Splits the brackets outside quotes off each token: `(lease` and
 * `"rental agreement")` become `(`, `lease` and `"rental agreement"`, `)`.
 * `-(` negates its group, as `NOT (`. Brackets that don't pair up are
 * dropped rather than sent to KQL, which would reject them.
 */
function splitGroupBrackets(tokens: string[]): string[] {
  const split = tokens.flatMap((token) => {
    const parts: string[] = [];
    let rest = token;
    if (rest.startsWith(`-${GROUP_OPEN}`)) {
      parts.push(NEGATED_GROUP);
      rest = rest.slice(2);
    }
    while (rest.startsWith(GROUP_OPEN)) {
      parts.push(GROUP_OPEN);
      rest = rest.slice(1);
    }
    let closing = 0;
    // A bracket inside a phrase, before its closing quote, is the phrase's.
    while (rest.endsWith(GROUP_CLOSE) && isQuoteBalanced(rest.slice(0, -1))) {
      rest = rest.slice(0, -1);
      closing += 1;
    }
    return [
      ...parts,
      ...(rest ? [rest] : []),
      ...new Array<string>(closing).fill(GROUP_CLOSE),
    ];
  });
  let depth = 0;
  for (const token of split) {
    if (token === GROUP_OPEN || token === NEGATED_GROUP) depth += 1;
    if (token === GROUP_CLOSE) depth -= 1;
    if (depth < 0) break;
  }
  if (depth === 0)
    return split.flatMap((token) =>
      token === NEGATED_GROUP ? [NOT, GROUP_OPEN] : [token],
    );
  // Unpaired: a negated group's first word stays negated.
  const flat: string[] = [];
  for (let index = 0; index < split.length; index++) {
    const token = split[index];
    if (token === GROUP_OPEN || token === GROUP_CLOSE) continue;
    if (token !== NEGATED_GROUP) {
      flat.push(token);
      continue;
    }
    const next = split[index + 1];
    if (next && next !== GROUP_OPEN && next !== GROUP_CLOSE) {
      flat.push(`-${next}`);
      index += 1;
    }
  }
  return flat;
}

function isQuoteBalanced(value: string) {
  return (value.match(/"/g)?.length ?? 0) % 2 === 0;
}

/**
 * Leaves only valid KQL once scopes and dropped terms have left gaps: no OR
 * beside a bracket, at either end or next to another OR, no NOT with
 * nothing after it, and no empty group.
 */
function tidyKqlTerms(terms: string[]) {
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < terms.length; index++) {
      const term = terms[index];
      const previous = terms[index - 1];
      const next = terms[index + 1];
      const strayOr =
        term === OR &&
        (previous === undefined ||
          previous === GROUP_OPEN ||
          previous === OR ||
          previous === NOT ||
          next === undefined ||
          next === GROUP_CLOSE);
      const strayNot =
        term === NOT &&
        (next === undefined || next === GROUP_CLOSE || next === OR);
      if (strayOr || strayNot) {
        terms.splice(index, 1);
        changed = true;
        break;
      }
      if (term === GROUP_OPEN && next === GROUP_CLOSE) {
        // A NOT before the group would otherwise negate what follows it.
        if (previous === NOT) terms.splice(index - 1, 3);
        else terms.splice(index, 2);
        changed = true;
        break;
      }
    }
  }
}

/** Whether any term matches mail rather than ruling it out. */
function hasPositiveTerm(terms: string[]) {
  // Whether each open group is negated.
  const negated: boolean[] = [];
  for (let index = 0; index < terms.length; index++) {
    const term = terms[index];
    if (term === GROUP_OPEN) {
      negated.push(terms[index - 1] === NOT || negated.at(-1) === true);
      continue;
    }
    if (term === GROUP_CLOSE) {
      negated.pop();
      continue;
    }
    if (term === OR || term === NOT || term.startsWith(`${NOT} `)) continue;
    if (!negated.at(-1)) return true;
  }
  return false;
}

function toKqlValue(value: string): string | null {
  const cleaned = value
    .replace(/[?"\u201c\u201d\u2018\u2019]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return null;
  const escaped = escapeSearchValue(cleaned);
  // An unquoted colon would turn literal text into a property restriction.
  return /[\s:]/.test(cleaned) ? `\\"${escaped}\\"` : escaped;
}

function parseSizeBytes(value: string): number | null {
  const match = value.match(/^(\d+(?:\.\d+)?)(mb|kb|m|k)?$/i);
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  let bytes = Number(match[1]);
  if (unit === "k" || unit === "kb") bytes *= 1024;
  if (unit === "m" || unit === "mb") bytes *= 1024 ** 2;
  if (!Number.isFinite(bytes)) return null;
  return Math.round(bytes);
}

function parseOutlookDate(value: string): string | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() !== Number(year)) return null;
  if (date.getUTCMonth() + 1 !== Number(month)) return null;
  if (date.getUTCDate() !== Number(day)) return null;
  return `${year}-${month}-${day}`;
}
