import type { MailPredicate } from "@inboxzero/mail-core/queries";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { SystemType } from "@/generated/prisma/enums";
import { getRuleLabel } from "@/utils/rule/consts";
import type { SearchNode } from "@/utils/mail-search/parse-search-query";
import { searchClauses } from "@/utils/mail-search/natural-language-search";
import {
  compileSearchNode,
  labelQueryName,
  type SearchLabel,
  type SearchQueryContext,
} from "@/utils/mail-search/search-query-predicate";

// Where a word of the search shows in a conversation. The body beyond its
// preview isn't in the list, so a word only there scores nothing extra: the
// store already found it in every result of the search that required it.
const SUBJECT_WEIGHT = 3;
const PEOPLE_WEIGHT = 2;
const PREVIEW_WEIGHT = 1;
const SENDER_MATCH = 2;
const IN_WINDOW = 2;
const OUT_OF_WINDOW = -2;
const CONDITION_MET = 1;
const CONDITION_UNMET = -2;
const LOW_PRIORITY = -4;
// How much a conversation's meaning counts, from the on-device model: up to
// a subject match at a similarity of 1, nothing at the floor. Only what the
// model clearly finds close leads alongside the search's own matches.
const SEMANTIC_WEIGHT = 4;
const SEMANTIC_FLOOR = 0.3;
const SEMANTIC_LEAD_SIMILARITY = 0.4;
// Recency only settles near ties: worth at most this, halving every month.
const MAX_RECENCY = 0.5;
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

// Mail people rarely search for unless they say so: Gmail's promotions and
// spam, and what Cue itself sorts as newsletters, marketing and cold email.
const LOW_PRIORITY_LABEL_IDS = new Set(["CATEGORY_PROMOTIONS", "SPAM"]);
const LOW_PRIORITY_LABEL_NAMES = new Set(
  [SystemType.NEWSLETTER, SystemType.MARKETING, SystemType.COLD_EMAIL].map(
    (type) => labelQueryName(getRuleLabel(type)),
  ),
);
const ROLE_LABEL = {
  inbox: "INBOX",
  sent: "SENT",
  draft: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
} as const;
const MAILBOX_LABEL: Partial<Record<string, string>> = {
  inbox: "INBOX",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  starred: "STARRED",
};
const SPACELESS_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;

export type CueRankingContext = Pick<
  SearchQueryContext,
  "now" | "timeZone" | "provider"
> & {
  /** The searches Cue read out of the sentence, before any widening. */
  searches: string[];
  /** The account's labels, for label conditions and Cue's own sorting. */
  labels: SearchLabel[];
  /**
   * How close each conversation is to the search in meaning, by id, for
   * those the on-device index found. Absent without vectors. Only
   * `rankWithWidened` reads it.
   */
  similarity?: ReadonlyMap<string, number>;
};

/**
 * Cue's matches ordered by how well each fits what the searches ask for:
 * how many of their word groups show, and where (subject, then people, then
 * preview); who it's from; whether it falls in their dates and meets their
 * conditions. Promotions, spam and mail Cue sorts as newsletters or
 * marketing go lower unless the search asks for them or for their sender.
 * Newer mail wins near ties. Local and synchronous: no model call.
 */
export function rankCueFoundThreads<T extends ListThread>(
  threads: T[],
  context: CueRankingContext,
): T[] {
  if (threads.length < 2) return threads;
  return sortByScore(
    scoreThreads(threads, { ...context, similarity: undefined }),
  );
}

/**
 * Cue's matches with what a wider tier, and the search by meaning, added
 * beyond them. The first search's matches lead, since they meet all of it,
 * except those it demotes (a promotion or newsletter the search didn't ask
 * for): those compete with the rest on how well they fit, so mail that fits
 * the search better comes first even when only a wider search found it.
 * Meaning stands in for the words the rest lacks, so it ranks only them;
 * the first search's matches keep their order. Mail found by meaning alone
 * must still meet the search's sender, dates and conditions, and leads only
 * when the model finds it clearly close.
 */
export function rankWithWidened<T extends ListThread>(
  primary: T[],
  widened: T[],
  context: CueRankingContext,
  bySimilarity: T[] = [],
): T[] {
  const found = new Set([...primary, ...widened].map((thread) => thread.id));
  const semanticOnly = bySimilarity.filter((thread) => !found.has(thread.id));
  if (!widened.length && !semanticOnly.length)
    return rankCueFoundThreads(primary, context);
  const semanticFrom = primary.length + widened.length;
  const primaryIds = new Set(primary.map((thread) => thread.id));
  const similarity = new Map(
    [...(context.similarity ?? [])].filter(([id]) => !primaryIds.has(id)),
  );
  const scored = scoreThreads([...primary, ...widened, ...semanticOnly], {
    ...context,
    similarity,
  }).filter((entry) => entry.index < semanticFrom || entry.meetsStructure);
  const leads = (entry: ScoredThread<T>) =>
    !entry.demoted &&
    (entry.index < primary.length ||
      (entry.index >= semanticFrom &&
        entry.similarity >= SEMANTIC_LEAD_SIMILARITY));
  return [
    ...sortByScore(scored.filter(leads)),
    ...sortByScore(scored.filter((entry) => !leads(entry))),
  ];
}

type ScoredThread<T> = {
  thread: T;
  index: number;
  latestMs: number;
  score: number;
  demoted: boolean;
  similarity: number;
  /** Meets the search's sender, dates and conditions, as far as the list shows. */
  meetsStructure: boolean;
};

function scoreThreads<T extends ListThread>(
  threads: T[],
  context: CueRankingContext,
): ScoredThread<T>[] {
  const facets = readFacets(context);
  const lowPriorityIds = new Set(LOW_PRIORITY_LABEL_IDS);
  for (const label of context.labels) {
    if (isLowPriorityLabelName(label.name))
      lowPriorityIds.add(labelKey(label.accountId, label.id));
  }
  const asksForLowPriority = facets.conditions.some((condition) =>
    mentionsLabel(condition, lowPriorityIds),
  );
  const nowMs = context.now.getTime();
  return threads.map((thread, index) => {
    const fields = threadFields(thread);
    const similarity = context.similarity?.get(thread.id) ?? 0;
    return {
      thread,
      index,
      latestMs: fields.latestMs,
      similarity,
      ...scoreThread(fields, facets, {
        lowPriorityIds,
        asksForLowPriority,
        nowMs,
        similarity,
      }),
    };
  });
}

function sortByScore<T>(scored: ScoredThread<T>[]): T[] {
  return [...scored]
    .sort(
      (a, b) =>
        b.score - a.score || b.latestMs - a.latestMs || a.index - b.index,
    )
    .map(({ thread }) => thread);
}

type Facets = {
  /** One group per thing the mail must mention, each its alternatives. */
  groups: string[][];
  people: { field: "from" | "to"; value: string }[];
  window: { afterMs: number | null; beforeMs: number | null } | null;
  conditions: MailPredicate[];
};

type ThreadFields = {
  subject: string;
  preview: string;
  from: string;
  to: string;
  labelIds: Set<string>;
  hasAttachments: boolean | undefined;
  latestMs: number;
  /** A row of a view across accounts, whose label ids are its account's. */
  accountId: string | undefined;
};

function scoreThread(
  fields: ThreadFields,
  facets: Facets,
  {
    lowPriorityIds,
    asksForLowPriority,
    nowMs,
    similarity,
  }: {
    lowPriorityIds: Set<string>;
    asksForLowPriority: boolean;
    nowMs: number;
    similarity: number;
  },
): { score: number; demoted: boolean; meetsStructure: boolean } {
  let score = 0;
  let meetsStructure = true;
  for (const group of facets.groups) {
    let best = 0;
    for (const term of group) {
      if (matchesWord(fields.subject, term)) best = SUBJECT_WEIGHT;
      else if (matchesWord(fields.from, term) || matchesWord(fields.to, term))
        best = Math.max(best, PEOPLE_WEIGHT);
      else if (matchesWord(fields.preview, term))
        best = Math.max(best, PREVIEW_WEIGHT);
    }
    score += best;
  }

  const fromSender = facets.people.some(({ field, value }) =>
    matchesWord(field === "from" ? fields.from : fields.to, value),
  );
  if (fromSender) score += SENDER_MATCH;
  else if (facets.people.length) meetsStructure = false;

  if (facets.window) {
    const { afterMs, beforeMs } = facets.window;
    const inside =
      (afterMs === null || fields.latestMs >= afterMs) &&
      (beforeMs === null || fields.latestMs < beforeMs);
    score += inside ? IN_WINDOW : OUT_OF_WINDOW;
    if (!inside) meetsStructure = false;
  }

  for (const condition of facets.conditions) {
    const met = conditionMet(condition, fields);
    if (met === true) score += CONDITION_MET;
    if (met === false) {
      score += CONDITION_UNMET;
      meetsStructure = false;
    }
  }

  score +=
    SEMANTIC_WEIGHT *
    Math.max(0, (similarity - SEMANTIC_FLOOR) / (1 - SEMANTIC_FLOOR));

  const lowPriority = [...fields.labelIds].some(
    (id) =>
      lowPriorityIds.has(id) ||
      lowPriorityIds.has(labelKey(fields.accountId, id)),
  );
  const demoted = lowPriority && !asksForLowPriority && !fromSender;
  if (demoted) score += LOW_PRIORITY;

  const ageMs = Math.max(0, nowMs - fields.latestMs);
  return {
    score: score + MAX_RECENCY * 0.5 ** (ageMs / RECENCY_HALF_LIFE_MS),
    demoted,
    meetsStructure,
  };
}

function readFacets(context: CueRankingContext): Facets {
  const facets: Facets = {
    groups: [],
    people: [],
    window: null,
    conditions: [],
  };
  for (const search of context.searches) {
    for (const { node, role } of searchClauses(search)) {
      if (role === "words") {
        const terms = wordsOf(node).map(normalize).filter(Boolean);
        if (terms.length) facets.groups.push(terms);
      } else if (role === "person") {
        facets.people.push(...peopleOf(node));
      } else if (role === "date") {
        const range = compileSearchNode(node, context);
        if (range.kind !== "received") continue;
        const window = facets.window ?? { afterMs: null, beforeMs: null };
        if (range.afterMs !== null)
          window.afterMs = Math.max(
            window.afterMs ?? range.afterMs,
            range.afterMs,
          );
        if (range.beforeMs !== null)
          window.beforeMs = Math.min(
            window.beforeMs ?? range.beforeMs,
            range.beforeMs,
          );
        facets.window = window;
      } else {
        facets.conditions.push(compileSearchNode(node, context));
      }
    }
  }
  return facets;
}

function wordsOf(node: SearchNode): string[] {
  switch (node.kind) {
    case "text":
      return [node.value];
    case "operator":
      return node.name === "subject" || node.name === "body"
        ? [node.value]
        : [];
    case "or":
    case "and":
      return node.children.flatMap(wordsOf);
    default:
      return [];
  }
}

function peopleOf(node: SearchNode): Facets["people"] {
  if (node.kind === "or") return node.children.flatMap(peopleOf);
  if (node.kind !== "operator") return [];
  const value = normalize(node.value);
  if (!value) return [];
  return [{ field: node.name === "from" ? "from" : "to", value }];
}

function threadFields(thread: ListThread): ThreadFields {
  const messages = thread.messages ?? [];
  const labelIds = new Set<string>();
  let latestMs = 0;
  for (const message of messages) {
    for (const id of message.labelIds ?? []) labelIds.add(id);
    const at = Number(message.internalDate);
    if (Number.isFinite(at)) latestMs = Math.max(latestMs, at);
  }
  const first = messages[0];
  return {
    subject: normalize(first?.subject || first?.headers?.subject || ""),
    preview: normalize(
      [thread.snippet, ...messages.map((message) => message.snippet)].join(" "),
    ),
    from: normalize(messages.map((message) => message.headers?.from).join(" ")),
    to: normalize(messages.map((message) => message.headers?.to).join(" ")),
    labelIds,
    hasAttachments: thread.hasAttachments,
    latestMs,
    accountId: "account" in thread ? thread.account.id : undefined,
  };
}

/**
 * Whether the conversation meets a condition of the search, as far as the
 * list shows; null when it can't tell.
 */
function conditionMet(
  predicate: MailPredicate,
  fields: ThreadFields,
): boolean | null {
  switch (predicate.kind) {
    case "all":
    case "any": {
      const results = predicate.predicates.map((child) =>
        conditionMet(child, fields),
      );
      // One unmet child settles "all", one met child settles "any".
      const decisive = predicate.kind === "any";
      if (results.includes(decisive)) return decisive;
      return results.includes(null) ? null : !decisive;
    }
    case "not": {
      const met = conditionMet(predicate.predicate, fields);
      return met === null ? null : !met;
    }
    case "has_attachment":
      return fields.hasAttachments === undefined
        ? null
        : fields.hasAttachments === predicate.value;
    case "starred":
      return fields.labelIds.has("STARRED") === predicate.value;
    case "read":
      return !fields.labelIds.has("UNREAD") === predicate.value;
    case "membership":
      return fields.labelIds.has(predicate.id);
    case "role":
      return fields.labelIds.has(ROLE_LABEL[predicate.role]);
    case "mailbox": {
      const label = MAILBOX_LABEL[predicate.mailbox];
      return label ? fields.labelIds.has(label) : null;
    }
    default:
      return null;
  }
}

function mentionsLabel(predicate: MailPredicate, ids: Set<string>): boolean {
  switch (predicate.kind) {
    case "all":
    case "any":
      return predicate.predicates.some((child) => mentionsLabel(child, ids));
    case "membership":
      return (
        ids.has(predicate.id) ||
        ids.has(labelKey(predicate.accountId, predicate.id))
      );
    case "role":
      return predicate.role === "spam";
    case "mailbox":
      return predicate.mailbox === "spam";
    default:
      return false;
  }
}

// Label ids are each account's own (Gmail's Label_1 exists in every account),
// so a view across accounts keys them by account.
function labelKey(accountId: string | undefined, id: string) {
  return accountId ? `${accountId}:${id}` : id;
}

function isLowPriorityLabelName(name: string) {
  // Cue's labels may sit under a parent label.
  const leaf = name.split("/").at(-1) ?? name;
  return LOW_PRIORITY_LABEL_NAMES.has(labelQueryName(leaf));
}

/**
 * Whether a word of the search starts a word of the text, as the store
 * matches it; a phrase must start one and run on. In scripts written
 * without spaces, anywhere in the text.
 */
function matchesWord(text: string, term: string) {
  if (!term || !text) return false;
  if (SPACELESS_SCRIPT.test(term)) return text.includes(term);
  return ` ${text}`.includes(` ${term}`);
}

/** Lowercase, without accents, with any run of punctuation as one space. */
function normalize(value: string) {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
