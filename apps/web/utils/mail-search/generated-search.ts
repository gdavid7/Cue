import { TZDate } from "@date-fns/tz";
import {
  addDays,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subMonths,
  subYears,
} from "date-fns";
import { z } from "zod";
import type { SearchNode } from "@/utils/mail-search/parse-search-query";
import {
  labelQueryName,
  relativeAgeMs,
} from "@/utils/mail-search/search-query-predicate";
import { formatSearchNode } from "@/utils/mail-search/natural-language-search";

const MAX_GROUPS = 4;
const MAX_WORDS_PER_GROUP = 6;
const MAX_PEOPLE = 3;
const MAX_TERM_LENGTH = 60;
const MAX_LAST_N_DAYS = 3650;

/**
 * What a model reads out of a search typed as a sentence. Code builds the
 * search from it, so grouping, operators and dates are never the model's to
 * get right: it names the parts and picks a date range, and Cue does the
 * calendar arithmetic in the account's time zone.
 */
export const searchIntentSchema = z.object({
  senders: z
    .array(z.string())
    .describe(
      "Who the mail is from: people, companies or addresses the user names, as written (Sarah, Acme). Never a role or relation without a name (my landlord, the bank, mom): it can't be looked up, so add only words such mail would contain to keywordGroups (rent for a landlord).",
    ),
  recipients: z
    .array(z.string())
    .describe(
      "Who the mail was sent to, named the same way as senders. Empty if not named.",
    ),
  sentByUser: z
    .boolean()
    .describe("True when the user sent the mail themselves."),
  keywordGroups: z
    .array(z.array(z.string()))
    .describe(
      'Words the mail itself would contain, one group per thing it must mention: a mail matches with a word from every group. Put a thing\'s synonyms and translations in its group, e.g. [["lease", "rental agreement"]]; a named place or object is a thing of its own. Mail often names a thing by its own kind of message rather than the user\'s word (an airline\'s booking confirmation may never say "flight"), so include the words that kind of message would carry. For a question, use the words the mail holding the answer would contain. Use as few groups as find the mail, usually one or two, and none beyond the user\'s words when a sender or label already narrows it. Leave out filler, question words and words about the search itself (email, message, find).',
    ),
  hasAttachment: z
    .boolean()
    .describe(
      "True only when the user means a file is attached: a PDF, photos, a document.",
    ),
  unread: z.boolean().describe("True only when the user asks for unread mail."),
  starred: z
    .boolean()
    .describe("True only when the user asks for starred or flagged mail."),
  label: z
    .string()
    .describe("A label or folder the user names. Empty if none."),
  dateRange: z
    .enum([
      "none",
      "today",
      "yesterday",
      "this_week",
      "last_week",
      "this_month",
      "last_month",
      "this_year",
      "last_year",
      "last_n_days",
      "between",
    ])
    .describe(
      'When the mail arrived, only if the user says. The date of something the mail is about (tomorrow\'s interview, a flight next week) is not when it arrived: use "none". Use "between" for a named month, season, quarter or date.',
    ),
  lastNDays: z
    .number()
    .describe('For "last_n_days", how many days. 0 otherwise.'),
  fromDate: z
    .string()
    .describe('For "between", the first day, YYYY-MM-DD. Empty otherwise.'),
  toDate: z
    .string()
    .describe(
      'For "between", the last day, YYYY-MM-DD, included. Empty otherwise.',
    ),
  explanation: z
    .string()
    .describe(
      'One short line describing the search your other fields make, and only that: leave out what you didn\'t fill in, e.g. "Mail from Sarah with attachments in September about a lease".',
    ),
  isQuestion: z
    .boolean()
    .describe(
      "True when the search asks something the mail could answer (when is my flight?), false when it only looks for mail.",
    ),
});

export type SearchIntentParts = z.infer<typeof searchIntentSchema>;

type SearchSyntax = "google" | "microsoft";

/**
 * The search for a model's reading, in the account provider's syntax. Words
 * of one group are alternatives, groups and everything else must all match,
 * and dates are whole days in the account's time zone. Labels the account
 * doesn't have are left out. Null when nothing searchable is left.
 */
export function buildGeneratedSearch(
  parts: SearchIntentParts,
  {
    now,
    timeZone,
    provider,
    labelNames,
  }: {
    now: Date;
    /** The account's time zone, which "today" and "last week" are read in. */
    timeZone: string;
    provider: SearchSyntax;
    /** The account's labels (Outlook: categories). */
    labelNames: string[];
  },
): string | null {
  const clauses: SearchNode[] = [];

  const people = (name: "from" | "to", values: string[]) => {
    const nodes = cleanTerms(values)
      .slice(0, MAX_PEOPLE)
      .map((value) => operator(name, value));
    if (nodes.length) clauses.push(anyOf(nodes));
  };
  people("from", parts.senders);
  people("to", parts.recipients);
  if (parts.sentByUser) clauses.push(operator("in", "sent"));

  for (const group of parts.keywordGroups.slice(0, MAX_GROUPS)) {
    const words = cleanTerms(group).slice(0, MAX_WORDS_PER_GROUP);
    if (words.length) clauses.push(anyOf(words.map(text)));
  }

  if (parts.hasAttachment)
    clauses.push(
      provider === "microsoft"
        ? operator("hasattachments", "true")
        : operator("has", "attachment"),
    );
  if (parts.unread && provider === "google")
    clauses.push(operator("is", "unread"));
  if (parts.starred)
    clauses.push(
      operator("is", provider === "microsoft" ? "flagged" : "starred"),
    );

  const label = matchLabel(parts.label, labelNames);
  if (label)
    clauses.push(
      operator(provider === "microsoft" ? "category" : "label", label),
    );

  const range = resolveDateRange(parts, { now, timeZone });
  if (range) clauses.push(...dateClauses(range, { timeZone, provider }));
  if (!clauses.length) return null;

  return formatSearchNode(
    clauses.length === 1 ? clauses[0] : { kind: "and", children: clauses },
  );
}

/**
 * A built search with its epoch-second dates written as the account's local
 * days, for a person to read and edit. Gmail reads those days at midnight
 * Pacific, close enough for a search someone is editing.
 */
export function readableSearch(search: string, timeZone: string): string {
  return search.replace(
    /\b(after|before):(\d{9,11})\b/g,
    (_, name: string, seconds: string) =>
      `${name}:${localDate(Number(seconds) * 1000, timeZone).replaceAll("-", "/")}`,
  );
}

export type DateRange = { startMs: number | null; endMs: number | null };

/**
 * The range a reading's date names, in the account's time zone: from the
 * start of its first day to the start of the day after its last. Weeks start
 * on Monday. Null when it names none, or one that holds no past mail.
 */
export function resolveDateRange(
  parts: Pick<
    SearchIntentParts,
    "dateRange" | "lastNDays" | "fromDate" | "toDate"
  >,
  { now, timeZone }: { now: Date; timeZone: string },
): DateRange | null {
  const local = new TZDate(now.getTime(), timeZone);
  const today = startOfDay(local);
  const week = startOfWeek(local, { weekStartsOn: 1 });
  const month = startOfMonth(local);
  const year = startOfYear(local);
  const ms = (date: Date) => date.getTime();
  let range: DateRange;
  switch (parts.dateRange) {
    case "today":
      range = { startMs: ms(today), endMs: null };
      break;
    case "yesterday":
      range = { startMs: ms(addDays(today, -1)), endMs: ms(today) };
      break;
    case "this_week":
      range = { startMs: ms(week), endMs: null };
      break;
    case "last_week":
      range = { startMs: ms(addDays(week, -7)), endMs: ms(week) };
      break;
    case "this_month":
      range = { startMs: ms(month), endMs: null };
      break;
    case "last_month":
      range = { startMs: ms(subMonths(month, 1)), endMs: ms(month) };
      break;
    case "this_year":
      range = { startMs: ms(year), endMs: null };
      break;
    case "last_year":
      range = { startMs: ms(subYears(year, 1)), endMs: ms(year) };
      break;
    case "last_n_days": {
      const days = Math.floor(parts.lastNDays);
      if (!(days >= 1 && days <= MAX_LAST_N_DAYS)) return null;
      range = { startMs: relativeAgeMs(`${days}d`, now), endMs: null };
      break;
    }
    case "between": {
      const from = localDay(parts.fromDate, timeZone);
      const to = localDay(parts.toDate, timeZone);
      if (!from && !to) return null;
      range = {
        startMs: from ? ms(from) : null,
        endMs: to ? ms(addDays(to, 1)) : null,
      };
      break;
    }
    default:
      return null;
  }
  if (range.startMs !== null && range.startMs > now.getTime()) return null;
  if (
    range.startMs !== null &&
    range.endMs !== null &&
    range.startMs >= range.endMs
  )
    return null;
  return range;
}

/**
 * Gmail reads a plain date as midnight Pacific, so it gets the instant in
 * epoch seconds. Outlook compares whole days, written in the account's time
 * zone.
 */
function dateClauses(
  { startMs, endMs }: DateRange,
  { timeZone, provider }: { timeZone: string; provider: SearchSyntax },
): SearchNode[] {
  const clauses: SearchNode[] = [];
  if (provider === "microsoft") {
    if (startMs !== null)
      clauses.push(received(">=", localDate(startMs, timeZone)));
    if (endMs !== null) clauses.push(received("<", localDate(endMs, timeZone)));
    return clauses;
  }
  if (startMs !== null)
    clauses.push(operator("after", String(Math.floor(startMs / 1000))));
  if (endMs !== null)
    clauses.push(operator("before", String(Math.floor(endMs / 1000))));
  return clauses;
}

function localDay(value: string, timeZone: string): TZDate | null {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new TZDate(year, month - 1, day, timeZone);
  // Rolled over, so not a real day (February 30).
  if (date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return date;
}

function localDate(ms: number, timeZone: string) {
  const date = new TZDate(ms, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function matchLabel(value: string, labelNames: string[]) {
  const wanted = labelQueryName(value);
  if (!wanted) return null;
  return labelNames.find((name) => labelQueryName(name) === wanted) ?? null;
}

function cleanTerms(values: string[]) {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    // Brackets, quotes and a leading - or + would read as search syntax.
    const term = value
      .replace(/["(){}]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^[-+]+/, "")
      .slice(0, MAX_TERM_LENGTH);
    const key = term.toLowerCase();
    // A term with no letter or digit (a stray backslash) matches nothing.
    if (
      !/[\p{L}\p{N}]/u.test(term) ||
      seen.has(key) ||
      /^(OR|AND|NOT|AROUND)$/.test(term)
    )
      return [];
    seen.add(key);
    return [term];
  });
}

function anyOf(nodes: SearchNode[]): SearchNode {
  return nodes.length === 1 ? nodes[0] : { kind: "or", children: nodes };
}

function text(value: string): SearchNode {
  // Quoted when a colon would make the word read as an operator.
  return { kind: "text", value, exact: /[\s:]/.test(value) };
}

function operator(name: string, value: string): SearchNode {
  return {
    kind: "operator",
    name,
    comparator: ":",
    value,
    quoted: /\s/.test(value),
  };
}

function received(comparator: ">=" | "<", value: string): SearchNode {
  return {
    kind: "operator",
    name: "received",
    comparator,
    value,
    quoted: false,
  };
}
