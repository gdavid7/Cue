import type { MailboxView, MailPredicate } from "@inboxzero/mail-core/queries";
import {
  type ActionableThread,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import {
  buildGeneratedSearch,
  type SearchIntentParts,
} from "@/utils/mail-search/generated-search";
import {
  type SearchLabel,
  searchProvider,
  searchQueryToPredicate,
} from "@/utils/mail-search/search-query-predicate";

/**
 * How many accounts' provider searches Cue has queued at once in All
 * inboxes. The engine runs them one at a time, so this bounds the queue: a
 * user with many accounts never lines up every account's search, at
 * interactive priority (D-086), behind one slow one.
 */
export const CUE_PROVIDER_SEARCH_QUEUE = 2;
/**
 * How long one account's provider may take, from when the engine began its
 * search, before Cue stops waiting on it, cancels it and gives its turn to
 * the next account. Its local mail still counts.
 */
export const CUE_ACCOUNT_SEARCH_TIMEOUT_MS = 8000;

export type CueSearchAccount = {
  id: string;
  provider: string;
  labels: SearchLabel[];
};

export type AccountCueSearch = { accountId: string; search: string };

/**
 * Each account's search for one model reading, in the account's own
 * provider's syntax and with its own labels, so the model is asked once
 * however many accounts are searched. An account left with nothing to
 * search is left out.
 */
export function getAccountCueSearches(
  parts: SearchIntentParts,
  accounts: CueSearchAccount[],
  { now, timeZone }: { now: Date; timeZone: string },
): AccountCueSearch[] {
  return accounts.flatMap((account) => {
    const search = buildGeneratedSearch(parts, {
      now,
      timeZone,
      provider: searchProvider(account.provider) ?? "google",
      labelNames: account.labels.map((label) => label.name),
    });
    return search ? [{ accountId: account.id, search }] : [];
  });
}

/**
 * The one search every account's matches are ranked by, so they rank on one
 * scale. It leaves out the label: each account's matches already sit under
 * that account's own label, and one account's label id would count against
 * every other account's mail.
 */
export function getCueRankingSearch(
  parts: SearchIntentParts,
  { now, timeZone }: { now: Date; timeZone: string },
): string[] {
  const search = buildGeneratedSearch(
    { ...parts, label: "" },
    { now, timeZone, provider: "google", labelNames: [] },
  );
  return search ? [search] : [];
}

export type AccountSearchPhase =
  | "waiting"
  | "searching"
  | "finished"
  | "timedOut";

/**
 * Where each account's provider search is. At most `queueSize` are queued
 * or running at once, in the accounts' order; an account waiting its turn
 * reads its local mail alone. An account is timed out `timeoutMs` after the
 * engine began its search (`startedAtMs`), never counting its wait in the
 * queue, which frees its turn. `toQueue` are the accounts whose turn has
 * come and `toTimeOut` the ones whose time ran out, for the caller to
 * record.
 */
export function scheduleAccountSearches({
  accountIds,
  queuedIds,
  finishedIds,
  timedOutIds,
  startedAtMs,
  nowMs,
  queueSize = CUE_PROVIDER_SEARCH_QUEUE,
  timeoutMs = CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
}: {
  accountIds: string[];
  queuedIds: ReadonlySet<string>;
  finishedIds: ReadonlySet<string>;
  timedOutIds: ReadonlySet<string>;
  /** When the engine began each running account's search. */
  startedAtMs: Readonly<Record<string, number>>;
  nowMs: number;
  queueSize?: number;
  timeoutMs?: number;
}): {
  phases: Record<string, AccountSearchPhase>;
  toQueue: string[];
  toTimeOut: string[];
  /** When the next running search times out, to look again then. */
  nextDeadlineMs: number | null;
} {
  const phases: Record<string, AccountSearchPhase> = {};
  const toTimeOut: string[] = [];
  let searching = 0;
  let nextDeadlineMs: number | null = null;
  for (const id of accountIds) {
    const started = startedAtMs[id];
    if (finishedIds.has(id)) phases[id] = "finished";
    else if (timedOutIds.has(id)) phases[id] = "timedOut";
    else if (!queuedIds.has(id)) phases[id] = "waiting";
    else if (started !== undefined && nowMs - started >= timeoutMs) {
      phases[id] = "timedOut";
      toTimeOut.push(id);
    } else {
      phases[id] = "searching";
      searching++;
      if (started !== undefined)
        nextDeadlineMs = Math.min(
          nextDeadlineMs ?? Number.POSITIVE_INFINITY,
          started + timeoutMs,
        );
    }
  }
  const toQueue = accountIds
    .filter((id) => phases[id] === "waiting")
    .slice(0, Math.max(0, queueSize - searching));
  for (const id of toQueue) phases[id] = "searching";
  return { phases, toQueue, toTimeOut, nextDeadlineMs };
}

/** When the engine began each account's search that is still running. */
export function getProviderSearchStarts(
  providerSearch: NonNullable<MailboxView["providerSearch"]>,
): Record<string, number> {
  return Object.fromEntries(
    providerSearch.flatMap((account) =>
      account.startedAtMs === undefined
        ? []
        : [[account.accountId, account.startedAtMs] as const],
    ),
  );
}

/**
 * The accounts whose provider has answered the search, or never will: it
 * can't be reached, needs the account reconnected, or can't run it. A busy
 * provider is still on its way, so it waits out its time box.
 */
export function getFinishedProviderSearches(
  providerSearch: NonNullable<MailboxView["providerSearch"]>,
): string[] {
  return providerSearch.flatMap((account) =>
    account.answered ||
    (account.state !== "searching" && account.state !== "busy")
      ? [account.accountId]
      : [],
  );
}

/**
 * The predicate for every account's search together. An account whose
 * provider may search reads its local mail and its provider; one waiting
 * its turn, or timed out, reads its local mail alone. Each search covers
 * only its own account, so no account's syntax reaches another account and
 * an account left out is never searched.
 */
export function getAccountsCuePredicate({
  searches,
  accounts,
  providerAccountIds,
  unreadOnly,
  now,
  timeZone,
}: {
  searches: AccountCueSearch[];
  accounts: CueSearchAccount[];
  providerAccountIds: ReadonlySet<string>;
  /** Keeps only unread mail, for a provider whose search can't. */
  unreadOnly: boolean;
  now: Date;
  timeZone: string;
}): MailPredicate | undefined {
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const predicates = searches.flatMap(({ accountId, search }) => {
    const account = byId.get(accountId);
    if (!account) return [];
    const predicate = searchQueryToPredicate(
      search,
      {
        now,
        timeZone,
        provider: searchProvider(account.provider),
        labels: account.labels,
      },
      [accountId],
    );
    if (!predicate) return [];
    const scoped = providerAccountIds.has(accountId)
      ? predicate
      : localOnly(predicate);
    const microsoftUnread =
      unreadOnly && searchProvider(account.provider) === "microsoft";
    return [
      microsoftUnread
        ? ({
            kind: "all",
            predicates: [scoped, { kind: "read", value: false }],
          } satisfies MailPredicate)
        : scoped,
    ];
  });
  if (!predicates.length) return;
  return predicates.length === 1 ? predicates[0] : { kind: "any", predicates };
}

/**
 * Cue's rows once its time is spent. The rows on screen then keep their
 * places, and each batch a slower account finds afterwards lands below
 * them in the order it arrived, so nothing on screen moves. `order` is the
 * keys in their places so far; the result's order adds the new ones.
 */
export function holdRowOrder<T extends ActionableThread>(
  threads: T[],
  order: string[],
): { threads: T[]; order: string[] } {
  const known = new Set(order);
  const added = threads.map(getListThreadKey).filter((key) => !known.has(key));
  const nextOrder = added.length ? [...order, ...added] : order;
  const position = new Map(nextOrder.map((key, index) => [key, index]));
  return {
    threads: [...threads].sort(
      (a, b) =>
        (position.get(getListThreadKey(a)) ?? 0) -
        (position.get(getListThreadKey(b)) ?? 0),
    ),
    order: nextOrder,
  };
}

/** A search's local part alone, for its own account only. */
function localOnly(predicate: MailPredicate): MailPredicate {
  switch (predicate.kind) {
    case "search":
      return predicate.accountIds
        ? {
            kind: "all",
            predicates: [
              { kind: "account", ids: predicate.accountIds },
              predicate.local,
            ],
          }
        : predicate.local;
    case "all":
    case "any":
      return { ...predicate, predicates: predicate.predicates.map(localOnly) };
    case "not":
      return { ...predicate, predicate: localOnly(predicate.predicate) };
    default:
      return predicate;
  }
}
