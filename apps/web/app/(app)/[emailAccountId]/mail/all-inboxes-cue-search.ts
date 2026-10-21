import type { MailboxView, MailPredicate } from "@inboxzero/mail-core/queries";
import {
  type CueWidening,
  getNextWidening,
  getWideningLadder,
  type getWideningStep,
  localOnly,
  type WideningStep,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import {
  type ActionableThread,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import {
  buildGeneratedSearch,
  type SearchIntentParts,
} from "@/utils/mail-search/generated-search";
import { WIDENING_TIERS } from "@/utils/mail-search/natural-language-search";
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
/**
 * The least time left in an account's box for its last resort to be worth
 * sending: less, and it would be cancelled before its provider answers.
 */
export const MIN_LAST_RESORT_MS = 1500;
// The engine runs searches one at a time, so a queued one may wait about a
// box behind another; past two, its start is taken as lost.
const QUEUED_TIMEOUT_FACTOR = 2;

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
 * engine began its search (`startedAtMs`), never counting a normal wait in
 * the queue, which frees its turn. One the engine never reports starting is
 * timed out `QUEUED_TIMEOUT_FACTOR` boxes after it was queued, so it can't
 * hold its turn for good. `toQueue` are the accounts whose turn has come and
 * `toTimeOut` the ones whose time ran out, for the caller to record.
 *
 * An id may also be an account's last resort (`lastResortSearchId`), which
 * waits in the same queue; `spentMs` is the time its account's provider
 * already took, which comes off its box, so an account's provider never
 * runs longer in all than one box.
 */
export function scheduleAccountSearches({
  accountIds,
  queuedAtMs,
  finishedIds,
  timedOutIds,
  startedAtMs,
  spentMs = {},
  nowMs,
  queueSize = CUE_PROVIDER_SEARCH_QUEUE,
  timeoutMs = CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
}: {
  accountIds: string[];
  /** When Cue queued each account's provider search. */
  queuedAtMs: Readonly<Record<string, number>>;
  finishedIds: ReadonlySet<string>;
  timedOutIds: ReadonlySet<string>;
  /** When the engine began each running account's search. */
  startedAtMs: Readonly<Record<string, number>>;
  /** Time a search's account already spent on its provider. */
  spentMs?: Readonly<Record<string, number>>;
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
    const queued = queuedAtMs[id];
    const deadline =
      (started !== undefined
        ? started + timeoutMs
        : (queued ?? 0) + timeoutMs * QUEUED_TIMEOUT_FACTOR) -
      (spentMs[id] ?? 0);
    if (finishedIds.has(id)) phases[id] = "finished";
    else if (timedOutIds.has(id)) phases[id] = "timedOut";
    else if (queued === undefined) phases[id] = "waiting";
    else if (nowMs >= deadline) {
      phases[id] = "timedOut";
      toTimeOut.push(id);
    } else {
      phases[id] = "searching";
      searching++;
      nextDeadlineMs = Math.min(
        nextDeadlineMs ?? Number.POSITIVE_INFINITY,
        deadline,
      );
    }
  }
  const toQueue = accountIds
    .filter((id) => phases[id] === "waiting")
    .slice(0, Math.max(0, queueSize - searching));
  for (const id of toQueue) phases[id] = "searching";
  return { phases, toQueue, toTimeOut, nextDeadlineMs };
}

/**
 * The scheduler's id for an account's last resort: its widest searches sent
 * to its provider too, once nothing local turned up.
 */
export function lastResortSearchId(accountId: string) {
  return `${accountId}:last-resort`;
}

/**
 * Each account's widening ladder, from its own search in its own syntax, as
 * a single account's search widens. Accounts left out have none.
 */
export function getAccountWideningLadders(
  searches: AccountCueSearch[],
  accounts: CueSearchAccount[],
  { now, timeZone }: { now: Date; timeZone: string },
): Record<string, WideningStep[]> {
  const ladders: Record<string, WideningStep[]> = {};
  for (const account of accounts) {
    const own = searches
      .filter((search) => search.accountId === account.id)
      .map(({ search }) => search);
    if (!own.length) continue;
    ladders[account.id] = getWideningLadder(own, {
      now,
      timeZone,
      provider: searchProvider(account.provider) ?? "google",
    });
  }
  return ladders;
}

export type AccountWidening = { step: number; onProvider: boolean };
type LadderWindow = Parameters<typeof getWideningStep>[0]["primary"];
const NOT_SETTLED: LadderWindow = { settled: false, count: 0 };

/**
 * The widening steps that change now, by account, or null when none does.
 * Each account climbs its own ladder by the single-account rules: only once
 * its own searches answered with too little, and never past the budget. Its
 * last resort goes to its provider only when `providerAllowedIds` has it:
 * its first provider search answered within its box.
 */
export function getNextAccountWidenings({
  ladders,
  widenings,
  primary,
  widened,
  expired,
  providerAllowedIds,
}: {
  ladders: Readonly<Record<string, WideningStep[]>>;
  widenings: Readonly<Record<string, AccountWidening>>;
  /** Each account's first search: its mail, and whether it has answered. */
  primary: Readonly<Record<string, LadderWindow>>;
  /** Each account's current tier; `count` is mail its first search missed. */
  widened: Readonly<Record<string, LadderWindow>>;
  expired: boolean;
  providerAllowedIds: ReadonlySet<string>;
}): Record<string, AccountWidening> | null {
  const changes: Record<string, AccountWidening> = {};
  for (const [accountId, ladder] of Object.entries(ladders)) {
    const next = getNextWidening(
      {
        primary: primary[accountId] ?? NOT_SETTLED,
        widened: widened[accountId] ?? NOT_SETTLED,
        ladderLength: ladder.length,
        expired,
      },
      widenings[accountId] ?? null,
      { mayAskProvider: providerAllowedIds.has(accountId) },
    );
    if (next) changes[accountId] = next;
  }
  return Object.keys(changes).length ? changes : null;
}

/** Each widening account's searches for its current tier. */
export function getAccountsWidenedSearches(
  ladders: Readonly<Record<string, WideningStep[]>>,
  widenings: Readonly<Record<string, AccountWidening>>,
): AccountCueSearch[] {
  return Object.entries(ladders).flatMap(([accountId, ladder]) => {
    const widening = widenings[accountId];
    const tier = widening ? ladder[widening.step] : undefined;
    return (tier?.searches ?? []).map((search) => ({ accountId, search }));
  });
}

/**
 * The predicate for every widening account's current tier. Tiers read the
 * local mail alone; an account in `lastResortIds` also sends the first of
 * its tier's searches to its provider, and only that one, so its last
 * resort is a single provider search that answers or times out as one.
 */
export function getAccountsWidenedPredicate({
  searches,
  accounts,
  lastResortIds,
  now,
  timeZone,
}: {
  searches: AccountCueSearch[];
  accounts: CueSearchAccount[];
  lastResortIds: ReadonlySet<string>;
  now: Date;
  timeZone: string;
}): MailPredicate | undefined {
  const onProvider = new Set<string>();
  const toProvider: AccountCueSearch[] = [];
  const local: AccountCueSearch[] = [];
  for (const search of searches) {
    if (
      lastResortIds.has(search.accountId) &&
      !onProvider.has(search.accountId)
    ) {
      onProvider.add(search.accountId);
      toProvider.push(search);
    } else local.push(search);
  }
  const shared = { accounts, unreadOnly: false, now, timeZone };
  const predicates = [
    getAccountsCuePredicate({
      ...shared,
      searches: toProvider,
      providerAccountIds: lastResortIds,
    }),
    getAccountsCuePredicate({
      ...shared,
      searches: local,
      providerAccountIds: new Set(),
    }),
  ].filter((predicate) => predicate !== undefined);
  if (predicates.length < 2) return predicates[0];
  return { kind: "any", predicates };
}

/**
 * What Cue says it widened to across accounts: the widest tier any account
 * reached, every account's searches for its tier, and whether any went to
 * its provider.
 */
export function summarizeAccountWidenings(
  ladders: Readonly<Record<string, WideningStep[]>>,
  widenings: Readonly<Record<string, AccountWidening>>,
): CueWidening | null {
  let widest: WideningStep | null = null;
  let onProvider = false;
  const searches = new Set<string>();
  for (const [accountId, ladder] of Object.entries(ladders)) {
    const widening = widenings[accountId];
    const tier = widening ? ladder[widening.step] : undefined;
    if (!widening || !tier) continue;
    for (const search of tier.searches) searches.add(search);
    onProvider ||= widening.onProvider;
    if (
      !widest ||
      WIDENING_TIERS.indexOf(tier.tier) > WIDENING_TIERS.indexOf(widest.tier)
    )
      widest = tier;
  }
  return widest
    ? { tier: widest.tier, searches: [...searches], onProvider }
    : null;
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
