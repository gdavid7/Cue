import { isValidEmail } from "@/utils/email";
import { isMicrosoftProvider } from "@/utils/email/provider-types";

/** A chat search, as it is asked of each of the user's accounts. */
export type AccountSearch = {
  query: string;
  fromEmail?: string | null;
  readState?: "read" | "unread" | null;
};

type ReadState = "read" | "unread";

/** What a search asks for, independent of either provider's syntax. */
type Criteria = {
  words: string[];
  from?: string;
  to?: string;
  subject?: string;
  hasAttachment?: boolean;
  readState?: ReadState;
  after?: string;
  before?: string;
  /** Something in the search had no equivalent and was left out. */
  dropped: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_PATTERN =
  /(-?)(\w+)(:|>=|<=|>|<)(?:"([^"]*)"|(\S+))|"([^"]*)"|(\S+)/g;
const COMPARISON_SPACING =
  /\b(received(?:datetime)?|sent(?:datetime)?)\s*(>=|<=|>|<)\s*/gi;

/**
 * A search written in the chat account's provider's syntax, rewritten for
 * another account's provider. Filters both providers share are carried over;
 * when something can't be, the search falls back to its keywords and says
 * so. Null when nothing in the search applies to the other provider.
 */
export function translateAccountSearch({
  search,
  from,
  to,
  now = new Date(),
}: {
  search: AccountSearch;
  from: string;
  to: string;
  now?: Date;
}): { search: AccountSearch; keywordsOnly: boolean } | null {
  const fromOutlook = isMicrosoftProvider(from);
  const toOutlook = isMicrosoftProvider(to);
  if (fromOutlook === toOutlook) return { search, keywordsOnly: false };

  const criteria = fromOutlook
    ? parseOutlookSearch(search)
    : parseGmailQuery(search.query, now);
  return toOutlook ? toOutlookSearch(criteria) : toGmailSearch(criteria);
}

function parseGmailQuery(query: string, now: Date): Criteria {
  const criteria: Criteria = { words: [], dropped: false };

  for (const token of tokenize(query)) {
    if (token.kind === "word") {
      addWord(criteria, token.value);
      continue;
    }
    const { field, operator, value, negated } = token;
    if (negated || operator !== ":") {
      criteria.dropped = true;
      continue;
    }

    if (field === "from") criteria.from = value;
    else if (field === "to") criteria.to = value;
    else if (field === "subject") criteria.subject = value;
    else if (field === "is" && (value === "unread" || value === "read"))
      criteria.readState = value;
    else if (field === "has" && value === "attachment")
      criteria.hasAttachment = true;
    else if (field === "after" && toIsoDate(value))
      criteria.after = toIsoDate(value);
    else if (field === "before" && toIsoDate(value))
      criteria.before = toIsoDate(value);
    else if (field === "newer_than" && relativeDate(value, now))
      criteria.after = relativeDate(value, now);
    else if (field === "older_than" && relativeDate(value, now))
      criteria.before = relativeDate(value, now);
    else criteria.dropped = true;
  }

  return criteria;
}

function parseOutlookSearch(search: AccountSearch): Criteria {
  const criteria: Criteria = {
    words: [],
    dropped: false,
    from: search.fromEmail ?? undefined,
    readState: search.readState ?? undefined,
  };

  for (const token of tokenize(
    search.query.replace(COMPARISON_SPACING, "$1$2"),
  )) {
    if (token.kind === "word") {
      const lower = token.value.toLowerCase();
      if (lower === "read" || lower === "unread") {
        criteria.readState ??= lower;
        continue;
      }
      addWord(criteria, token.value);
      continue;
    }
    const { field, operator, value, negated } = token;
    if (negated) {
      criteria.dropped = true;
      continue;
    }

    if (operator !== ":") {
      const date = toIsoDate(value.slice(0, 10));
      if (!date || !/^(received|sent)/.test(field)) {
        criteria.dropped = true;
      } else if (operator.startsWith(">")) {
        criteria.after = operator === ">" ? addDays(date, 1) : date;
      } else {
        criteria.before = operator === "<=" ? addDays(date, 1) : date;
      }
      continue;
    }

    if (field === "from") criteria.from ??= value;
    else if (field === "to") criteria.to = value;
    else if (field === "subject") criteria.subject = value;
    else if (/^hasattachments?$/.test(field) && value.toLowerCase() === "true")
      criteria.hasAttachment = true;
    else {
      // Fields such as participants: or body: still name what to look for.
      addWord(criteria, value);
      criteria.dropped = true;
    }
  }

  return criteria;
}

function toGmailSearch(criteria: Criteria) {
  const query = [
    criteria.from && `from:${quote(criteria.from)}`,
    criteria.to && `to:${quote(criteria.to)}`,
    criteria.subject && `subject:${quote(criteria.subject)}`,
    criteria.hasAttachment && "has:attachment",
    criteria.readState && `is:${criteria.readState}`,
    criteria.after && `after:${criteria.after.replaceAll("-", "/")}`,
    criteria.before && `before:${criteria.before.replaceAll("-", "/")}`,
    ...criteria.words,
  ]
    .filter(Boolean)
    .join(" ");

  if (!query) return null;
  return { search: { query }, keywordsOnly: criteria.dropped };
}

// Outlook's search takes the sender and read state as filters, but only one
// field clause on its own: with more, or with words, it searches the text.
function toOutlookSearch(criteria: Criteria) {
  const fromEmail =
    criteria.from && isValidEmail(criteria.from) ? criteria.from : undefined;
  const fieldValues = [
    criteria.subject,
    criteria.to,
    fromEmail ? undefined : criteria.from,
  ].filter((value): value is string => Boolean(value));
  const clauses = [
    criteria.subject && `subject:${quote(criteria.subject)}`,
    criteria.to && `to:${quote(criteria.to)}`,
    !fromEmail && criteria.from && `from:${quote(criteria.from)}`,
    criteria.hasAttachment && "hasattachments:true",
    criteria.after && `received>=${criteria.after}`,
    criteria.before && `received<${criteria.before}`,
  ].filter((clause): clause is string => Boolean(clause));

  const combinable =
    clauses.length === 0 ||
    (clauses.length === 1 && criteria.words.length === 0);
  const query = combinable
    ? (clauses[0] ?? criteria.words.join(" "))
    : [...criteria.words, ...fieldValues].join(" ");

  if (!query && !fromEmail && !criteria.readState) return null;
  return {
    search: {
      query,
      ...(fromEmail && { fromEmail }),
      ...(criteria.readState && { readState: criteria.readState }),
    },
    keywordsOnly: criteria.dropped || !combinable,
  };
}

type Token =
  | { kind: "word"; value: string }
  | {
      kind: "field";
      field: string;
      operator: string;
      value: string;
      negated: boolean;
    };

function tokenize(query: string): Token[] {
  return Array.from(query.matchAll(TOKEN_PATTERN), (match): Token => {
    const [, negation, field, operator, quotedValue, bareValue, phrase, word] =
      match;
    if (field) {
      return {
        kind: "field",
        field: field.toLowerCase(),
        operator,
        value: quotedValue ?? bareValue ?? "",
        negated: negation === "-",
      };
    }
    return { kind: "word", value: phrase !== undefined ? `"${phrase}"` : word };
  });
}

function addWord(criteria: Criteria, value: string) {
  const word = value.replace(/^\(+|\)+$/g, "");
  if (!word) return;
  // Boolean operators and exclusions change what matches; plain keywords
  // can't carry them.
  if (/^(AND|OR|NOT)$/.test(word) || word.startsWith("-")) {
    criteria.dropped = true;
    return;
  }
  criteria.words.push(word);
}

function quote(value: string) {
  return /\s/.test(value) ? `"${value}"` : value;
}

// Dates that don't exist, such as month 13 or a February 30, are left out
// rather than rolled over into another date.
function toIsoDate(value: string) {
  const match = value.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/);
  if (!match) return;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return;
  }
  return date.toISOString().slice(0, 10);
}

function relativeDate(value: string, now: Date) {
  const match = value.match(/^(\d+)([dmy])$/i);
  if (!match) return;
  const amount = Number(match[1]);
  const date = new Date(now);
  const unit = match[2].toLowerCase();
  if (unit === "d") date.setUTCDate(date.getUTCDate() - amount);
  else if (unit === "m") date.setUTCMonth(date.getUTCMonth() - amount);
  else date.setUTCFullYear(date.getUTCFullYear() - amount);
  // An age past what a date can hold leaves no date to search from.
  const year = date.getUTCFullYear();
  if (!Number.isFinite(date.getTime()) || year < 1 || year > 9999) return;
  return date.toISOString().slice(0, 10);
}

function addDays(isoDate: string, days: number) {
  return new Date(Date.parse(isoDate) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
