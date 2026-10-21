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
 * How many accounts' providers Cue searches at once in All inboxes. A search
 * is user-triggered, so it runs at interactive priority (D-086); the cap
 * keeps a user with many accounts from spending every account's quota at
 * the same moment.
 */
export const CUE_PROVIDER_SEARCH_CONCURRENCY = 2;
/**
 * How long one account's provider may take before Cue stops waiting on it
 * and gives its turn to the next account. Its local mail still counts.
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
 * Where each account's provider search is. At most `concurrency` search at
 * once, in the accounts' order; an account waiting its turn reads its local
 * mail alone. One whose provider hasn't answered within `timeoutMs` is
 * timed out, which frees its turn. `toStart` are the accounts whose turn has
 * come, which the caller marks started at `nowMs`.
 */
export function scheduleAccountSearches({
  accountIds,
  startedAtMs,
  finishedIds,
  nowMs,
  concurrency = CUE_PROVIDER_SEARCH_CONCURRENCY,
  timeoutMs = CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
}: {
  accountIds: string[];
  startedAtMs: Readonly<Record<string, number>>;
  finishedIds: ReadonlySet<string>;
  nowMs: number;
  concurrency?: number;
  timeoutMs?: number;
}): {
  phases: Record<string, AccountSearchPhase>;
  toStart: string[];
  /** When the next searching account times out, to look again then. */
  nextDeadlineMs: number | null;
} {
  const phases: Record<string, AccountSearchPhase> = {};
  let searching = 0;
  for (const id of accountIds) {
    const startedAt = startedAtMs[id];
    if (finishedIds.has(id)) phases[id] = "finished";
    else if (startedAt === undefined) phases[id] = "waiting";
    else if (nowMs - startedAt >= timeoutMs) phases[id] = "timedOut";
    else {
      phases[id] = "searching";
      searching++;
    }
  }
  const toStart = accountIds
    .filter((id) => phases[id] === "waiting")
    .slice(0, Math.max(0, concurrency - searching));
  for (const id of toStart) phases[id] = "searching";

  let nextDeadlineMs: number | null = null;
  for (const id of accountIds) {
    if (phases[id] !== "searching") continue;
    const deadline = (startedAtMs[id] ?? nowMs) + timeoutMs;
    nextDeadlineMs =
      nextDeadlineMs === null ? deadline : Math.min(nextDeadlineMs, deadline);
  }
  return { phases, toStart, nextDeadlineMs };
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
 * Cue's rows once its time is spent: the rows on screen then keep their
 * place, and mail a slower account finds afterwards lands below them, so
 * nothing moves above what is being read.
 */
export function keepFrozenRowsFirst<T extends ActionableThread>(
  threads: T[],
  frozenKeys: string[] | null,
): T[] {
  if (!frozenKeys) return threads;
  const frozen = new Set(frozenKeys);
  const kept: T[] = [];
  const late: T[] = [];
  for (const thread of threads)
    (frozen.has(getListThreadKey(thread)) ? kept : late).push(thread);
  return late.length ? [...kept, ...late] : kept;
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
