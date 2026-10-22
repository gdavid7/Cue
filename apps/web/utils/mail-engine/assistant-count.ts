import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  MailPredicate,
  MessageSearchMatch,
  MessageSearchPage,
} from "@inboxzero/mail-core/queries";
import {
  type CountGroupBy,
  LOCAL_COUNT_LIMITS,
  LOCAL_SEARCH_LIMITS,
  type LocalCountSearch,
  type LocalMailCountResult,
  type LocalMailSearchResult,
  localMailSearchResultSchema,
} from "@/utils/actions/assistant-local-search.validation";
import {
  coverageProblem,
  type LocalSearch,
  OUTLOOK_SEARCH_SCOPE,
  toLocalSearch,
  withTimeout,
} from "@/utils/mail-engine/assistant-search";

// A count reads every match a page at a time; the server stops waiting a
// little after this and asks the provider instead.
const DEFAULT_BUDGET_MS = 6000;
const PAGE_SIZE = 1000;

export type AssistantCountRequest = {
  requestId: string;
  searches: LocalCountSearch[];
  groupBy?: CountGroupBy;
};

type UnavailableReason = Extract<
  LocalMailSearchResult,
  { status: "unavailable" }
>["reason"];

type Example = { id: string; threadId: string; accountId: string; at: number };
type Group = { count: number; newest: Example };

/**
 * Counts what the assistant asked this tab to count and sends the answer
 * back, so the assistant never waits out its timeout. Only this browser's
 * own accounts are counted; the request arrives over the reply stream and
 * must not reach any other mailbox in the store.
 */
export async function answerAssistantCount({
  request,
  accountIds,
  client,
  submit,
}: {
  request: AssistantCountRequest;
  accountIds: string[];
  client: MailClient | null;
  submit: (input: {
    requestId: string;
    result: LocalMailSearchResult;
  }) => Promise<unknown>;
}) {
  const own = new Set(accountIds);
  const searches = request.searches
    .filter((search) => own.has(search.accountId))
    .slice(0, LOCAL_COUNT_LIMITS.accounts)
    .map(pickSearchFields);
  const groupBy = isGroupBy(request.groupBy) ? request.groupBy : undefined;
  const result: LocalMailSearchResult = client
    ? await countLocalMail({ client, searches, groupBy }).catch(
        () => ({ status: "unavailable", reason: "error" }) as const,
      )
    : { status: "unavailable", reason: "no_engine" };
  const accepted = localMailSearchResultSchema.safeParse(result).success
    ? result
    : ({ status: "unavailable", reason: "error" } as const);
  await submit({ requestId: request.requestId, result: accepted });
}

/**
 * Counts every message each search matches in the local store, as the
 * provider's own search would match them, and groups them. An account is
 * counted in full or listed unavailable, never in part, so every number it
 * answers is exact. Groups and examples carry message ids, not addresses or
 * subjects; month and week keys are read in the user's time zone.
 */
export async function countLocalMail({
  client,
  searches,
  groupBy,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  budgetMs = DEFAULT_BUDGET_MS,
}: {
  client: MailClient;
  searches: LocalCountSearch[];
  groupBy?: CountGroupBy;
  now?: Date;
  timeZone?: string;
  budgetMs?: number;
}): Promise<
  | LocalMailCountResult
  | Extract<LocalMailSearchResult, { status: "unavailable" }>
> {
  const searchMessages = client.searchMessages?.bind(client);
  if (!searchMessages) return { status: "unavailable", reason: "no_engine" };
  const deadline = Date.now() + budgetMs;

  const accounts: LocalMailCountResult["accounts"] = [];
  const groups = new Map<string, Group>();
  let newest: Example[] = [];

  for (const search of searches) {
    const local = localSearchFor(search, now, timeZone);
    if (!local) {
      accounts.push({
        accountId: search.accountId,
        unavailable: "unsupported_query",
      });
      continue;
    }

    const counted = await countAccount({
      searchMessages,
      accountId: search.accountId,
      local,
      groupKeys: groupBy
        ? groupKeyReader(groupBy, timeZone, search.syntax ?? "gmail")
        : null,
      deadline,
    });
    if ("unavailable" in counted) {
      accounts.push({
        accountId: search.accountId,
        unavailable: counted.unavailable,
      });
      continue;
    }

    accounts.push({ accountId: search.accountId, total: counted.total });
    for (const [key, group] of counted.groups) {
      const merged = groups.get(key);
      if (!merged) groups.set(key, group);
      else {
        merged.count += group.count;
        if (group.newest.at > merged.newest.at) merged.newest = group.newest;
      }
    }
    newest = [...newest, ...counted.newest]
      .sort((a, b) => b.at - a.at)
      .slice(0, LOCAL_COUNT_LIMITS.newest);
  }

  const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) =>
    groupBy === "month" || groupBy === "week"
      ? keyB.localeCompare(keyA)
      : b.count - a.count || b.newest.at - a.newest.at,
  );

  return {
    status: "counted",
    accounts,
    groupCount: groups.size,
    groups: ordered.slice(0, LOCAL_COUNT_LIMITS.groups).map(([key, group]) => ({
      // A sender's address stays in the browser; the server reads it from
      // the provider through the newest message it sent.
      ...(groupBy === "sender" ? {} : { key }),
      count: group.count,
      messageId: group.newest.id,
      accountId: group.newest.accountId,
    })),
    newest: newest.map(({ id, threadId, accountId }) => ({
      id,
      threadId,
      accountId,
    })),
  };
}

async function countAccount({
  searchMessages,
  accountId,
  local,
  groupKeys,
  deadline,
}: {
  searchMessages: NonNullable<MailClient["searchMessages"]>;
  accountId: string;
  local: LocalSearch;
  groupKeys: ((message: MessageSearchMatch) => string[]) | null;
  deadline: number;
}): Promise<
  | { total: number; groups: Map<string, Group>; newest: Example[] }
  | { unavailable: UnavailableReason }
> {
  const groups = new Map<string, Group>();
  const newest: Example[] = [];
  let total = 0;
  let after: string | null = null;

  do {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { unavailable: "timeout" };
    const page: MessageSearchPage | null = await withTimeout(
      searchMessages({
        accountId,
        predicate: local.predicate,
        fromAddress: local.fromAddress,
        pageSize: PAGE_SIZE,
        after,
      }),
      remaining,
    );
    if (!page) return { unavailable: "timeout" };
    if (after === null) {
      const problem = coverageProblem(
        page.coverage,
        accountId,
        local.predicate,
      );
      if (problem) return { unavailable: problem };
    }

    for (const message of page.messages) {
      if (
        message.messageId.length > LOCAL_SEARCH_LIMITS.id ||
        message.conversationId.length > LOCAL_SEARCH_LIMITS.id
      )
        continue;
      total += 1;
      const example: Example = {
        id: message.messageId,
        threadId: message.conversationId,
        accountId,
        at: message.receivedAtMs,
      };
      // Matches arrive newest first.
      if (newest.length < LOCAL_COUNT_LIMITS.newest) newest.push(example);
      for (const key of groupKeys?.(message) ?? []) {
        const group = groups.get(key);
        if (!group) groups.set(key, { count: 1, newest: example });
        else group.count += 1;
      }
    }
    after = page.nextPage;
  } while (after);

  return { total, groups, newest };
}

/**
 * The search for one account, or a search of all its mail when nothing
 * narrows it. Null when any part of it can't be answered exactly here.
 */
function localSearchFor(
  search: LocalCountSearch,
  now: Date,
  timeZone: string,
): LocalSearch | null {
  const outlook = search.syntax === "outlook";
  const blank =
    !search.query.trim() &&
    !(outlook && (search.fromEmail || search.readState));
  if (blank) {
    const allMail: MailPredicate = outlook
      ? OUTLOOK_SEARCH_SCOPE
      : { kind: "mailbox", mailbox: "all" };
    return { predicate: allMail, fromAddress: null };
  }
  return toLocalSearch({ ...search, now, timeZone });
}

function groupKeyReader(
  groupBy: CountGroupBy,
  timeZone: string,
  syntax: "gmail" | "outlook",
): (message: MessageSearchMatch) => string[] {
  switch (groupBy) {
    case "sender":
      // Mail the user sent isn't mail someone sent them.
      return (message) =>
        message.roles.includes("sent") ? [] : [senderAddress(message.from)];
    // Only ids the server can name from the provider's label list: Gmail's
    // labels and categories, Outlook's categories (its label ids are folders).
    case "label":
      return (message) => [
        ...new Set(
          [
            ...message.categoryIds,
            ...(syntax === "outlook" ? [] : message.labelIds),
          ].filter((id) => id.length <= LOCAL_COUNT_LIMITS.groupKey),
        ),
      ];
    case "month":
    case "week": {
      const format = new Intl.DateTimeFormat("en-US", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        weekday: "short",
      });
      return (message) => [periodKey(format, message.receivedAtMs, groupBy)];
    }
  }
}

const WEEKDAY_FROM_MONDAY: Record<string, number> = {
  Mon: 0,
  Tue: 1,
  Wed: 2,
  Thu: 3,
  Fri: 4,
  Sat: 5,
  Sun: 6,
};

/** The month (2026-10), or the date of the week's Monday (2026-10-19). */
function periodKey(
  format: Intl.DateTimeFormat,
  atMs: number,
  period: "month" | "week",
) {
  const parts = Object.fromEntries(
    format.formatToParts(new Date(atMs)).map((part) => [part.type, part.value]),
  );
  if (period === "month") return `${parts.year}-${parts.month}`;
  const monday = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) -
      (WEEKDAY_FROM_MONDAY[parts.weekday] ?? 0) * 24 * 60 * 60 * 1000,
  );
  return monday.toISOString().slice(0, 10);
}

function senderAddress(from: string) {
  const bracketed = from.match(/<([^<>]+)>\s*$/);
  return (bracketed?.[1] ?? from).trim().toLowerCase();
}

// Only the fields a search needs, so the request can't choose a store or
// timeout.
function pickSearchFields(search: LocalCountSearch): LocalCountSearch {
  const base = {
    accountId: String(search.accountId),
    query: String(search.query ?? ""),
  };
  return search.syntax === "outlook"
    ? {
        ...base,
        syntax: "outlook",
        fromEmail: search.fromEmail,
        readState: search.readState,
      }
    : { ...base, syntax: "gmail" };
}

function isGroupBy(value: unknown): value is CountGroupBy {
  return (
    value === "sender" ||
    value === "month" ||
    value === "week" ||
    value === "label"
  );
}
