"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  type AccountCueSearch,
  type AccountSearchPhase,
  type AccountWidening,
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  type CueSearchAccount,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getAccountsWidenedPredicate,
  getAccountsWidenedSearches,
  getAccountWideningLadders,
  getCueRankingSearch,
  getFinishedProviderSearches,
  getNextAccountWidenings,
  getProviderSearchStarts,
  holdRowOrder,
  lastResortSearchId,
  MIN_LAST_RESORT_MS,
  scheduleAccountSearches,
  summarizeAccountWidenings,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import {
  CUE_SEARCH_BUDGET_MS,
  type CueSearchIntent,
  getCueSearchStage,
  getSearchAnswerRequest,
  WIDEN_BELOW_RESULTS,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import {
  rankCueFoundThreads,
  rankWithWidened,
} from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import {
  getListThreadKey,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import { useLabels } from "@/hooks/useLabels";
import type { EmailLabels } from "@/providers/email-label-types";
import { engineProvider } from "@/utils/mail-engine/engine-accounts";
import { swrFetcher } from "@/providers/swr-fetcher";
import { readableSearch } from "@/utils/mail-search/generated-search";
import { looksLikeNaturalLanguage } from "@/utils/mail-search/natural-language-search";
import type { ThreadsQuery } from "@/utils/threads/validation";

const SEARCH_INTENT_PATH = "/api/user/search-intent";
const NO_THREADS: ListThread[] = [];
const NO_ACCOUNTS: AllInboxesAccount[] = [];
const NO_SEARCHES: AccountCueSearch[] = [];
const NO_IDS: string[] = [];
const NO_STARTS: Record<string, number> = {};
const NO_WIDENINGS: Record<string, AccountWidening> = {};
// The predicate carries the searches; the query only names the window.
const PREDICATE_ONLY_QUERY: ThreadsQuery = { q: "" };

type Run = {
  query: string;
  expired: boolean;
  /** The model hadn't answered when the budget ran out. */
  readingLate: boolean;
  /** The rows on screen when the budget ran out. */
  frozenKeys: string[] | null;
  /**
   * Each account's search, fixed when the reading arrives, so labels that
   * load later never start a search the queue didn't schedule.
   */
  searches: AccountCueSearch[] | null;
  /** When Cue queued each account's provider search. */
  queued: Record<string, number>;
  /**
   * Searches whose provider has answered, or never will, and when Cue saw
   * it. Keyed like `queued`: an account, or its last resort.
   */
  finished: Record<string, number>;
  /** Accounts whose provider took too long, and was stopped. */
  timedOut: string[];
  /**
   * When the engine began each account's search. Kept once seen, so a
   * window reloading for a new query doesn't restart an account's clock.
   */
  started: Record<string, number>;
  /** Each account's step up its widening ladder, once it found too little. */
  widenings: Record<string, AccountWidening>;
};

/**
 * Cue's search of a sentence typed in All inboxes. The model reads it once,
 * for the routed account, and that reading becomes a search in each
 * included account's own syntax and labels. Every account's local mail is
 * read at once. Their providers' searches are queued a couple at a time
 * (the engine runs them one by one), and each is timed from when the engine
 * began it, then cancelled if it runs too long, so a slow account never
 * holds up the others. What they find is ranked together on one scale and
 * each row keeps its account, so it opens there. Accounts left out of All
 * inboxes are never searched.
 *
 * An account whose search found too little widens it as a single account's
 * does, tier by tier on its local mail, and as a last resort sends its
 * widest searches to its provider through the same queue, within what is
 * left of its time box.
 */
export function useAllInboxesCueSearch({
  emailAccountId,
  accounts,
  labelsByAccount,
  query,
  enabled,
}: {
  /** The routed account, which reads the search. */
  emailAccountId: string;
  /** The accounts included in All inboxes. */
  accounts: AllInboxesAccount[];
  labelsByAccount: Record<string, EmailLabels>;
  /** The committed search, never the text being typed. */
  query: string | null;
  /** Off for users without AI and outside All inboxes. */
  enabled: boolean;
}) {
  const natural = Boolean(enabled && query && looksLikeNaturalLanguage(query));
  // The same request as a single account's search, with the routed
  // account's labels, so both views share one reading of the search.
  const { userLabels, isLoading: labelsLoading } = useLabels();
  const labelNamesRef = useRef<string[]>([]);
  labelNamesRef.current = userLabels.map((label) => label.name);
  const { data, error } = useSWR<GetSearchIntentResponse>(
    natural && query && !labelsLoading
      ? ([SEARCH_INTENT_PATH, emailAccountId, query] as const)
      : null,
    ([path, accountId, q]: readonly [string, string, string]) =>
      swrFetcher(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, labels: labelNamesRef.current }),
        },
        accountId,
      ),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const answered = data !== undefined || error !== undefined;

  const answeredRef = useRef(answered);
  const rowKeysRef = useRef<string[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    answeredRef.current = answered;
  }, [answered]);
  // The budget runs from commit, as for one account. Past it the rows on
  // screen hold their places, and a slower account's mail lands below them.
  useEffect(() => {
    if (!natural || !query) return;
    setRun({
      query,
      expired: false,
      readingLate: false,
      frozenKeys: null,
      searches: null,
      queued: {},
      finished: {},
      timedOut: [],
      started: {},
      widenings: {},
    });
    const timeout = setTimeout(() => {
      setRun((current) =>
        current?.query === query
          ? {
              ...current,
              expired: true,
              readingLate: !answeredRef.current,
              frozenKeys: rowKeysRef.current,
            }
          : current,
      );
    }, CUE_SEARCH_BUDGET_MS);
    return () => clearTimeout(timeout);
  }, [natural, query]);
  const current = run?.query === query ? run : null;
  const expired = Boolean(current?.expired);
  let intent: CueSearchIntent | null | undefined;
  if (answered && !current?.readingLate) intent = data ?? null;

  // Once per reading, so its dates, and recency, hold still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading is a new now
  const now = useMemo(() => new Date(), [intent]);
  const timeZone = intent?.timeZone ?? "UTC";
  const searchAccounts = useMemo<CueSearchAccount[]>(
    () =>
      accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        labels: Object.values(labelsByAccount[account.id] ?? {}).map(
          (label) => ({
            id: label.id,
            name: label.name,
            accountId: account.id,
          }),
        ),
      })),
    [accounts, labelsByAccount],
  );
  const builtSearches = useMemo(
    () =>
      intent?.parts
        ? getAccountCueSearches(intent.parts, searchAccounts, {
            now,
            timeZone,
          })
        : NO_SEARCHES,
    [intent, searchAccounts, now, timeZone],
  );
  // Frozen once read: a search that changed as labels loaded would be a new
  // provider search the queue never scheduled.
  const frozenSearches = current?.searches;
  const searches = frozenSearches ?? builtSearches;
  const hasIntent = Boolean(intent);
  useEffect(() => {
    if (!hasIntent || frozenSearches || !query) return;
    setRun((run) =>
      run?.query === query && !run.searches
        ? { ...run, searches: builtSearches }
        : run,
    );
  }, [hasIntent, frozenSearches, builtSearches, query]);
  const searchedIds = useMemo(
    () => searches.map((search) => search.accountId),
    [searches],
  );
  const ladders = useMemo(
    () =>
      getAccountWideningLadders(searches, searchAccounts, { now, timeZone }),
    [searches, searchAccounts, now, timeZone],
  );
  const widenings = current?.widenings ?? NO_WIDENINGS;
  const widenedSearches = useMemo(
    () => getAccountsWidenedSearches(ladders, widenings),
    [ladders, widenings],
  );
  const widenedIdsKey = [
    ...new Set(widenedSearches.map((search) => search.accountId)),
  ].join("\n");
  const widenedIds = useMemo(
    () => (widenedIdsKey ? widenedIdsKey.split("\n") : NO_IDS),
    [widenedIdsKey],
  );
  // Which accounts' providers search now: it looks again whenever one
  // answers or begins, and when a running one's time box runs out.
  const [clockMs, setClockMs] = useState(() => Date.now());
  const started = current?.started;
  const queuedAtMs = current?.queued ?? NO_STARTS;
  // An account's last resort waits its turn in the same queue as every
  // account's first search; one still waiting when the budget runs out is
  // dropped, since what it found would land after the rows were read.
  const scheduledIds = useMemo(
    () => [
      ...searchedIds,
      ...widenedIds
        .filter((id) => widenings[id]?.onProvider)
        .map(lastResortSearchId)
        .filter((id) => !expired || queuedAtMs[id] !== undefined),
    ],
    [searchedIds, widenedIds, widenings, expired, queuedAtMs],
  );
  const finishedAt = current?.finished ?? NO_STARTS;
  const finishedIds = useMemo(
    () => new Set(Object.keys(finishedAt)),
    [finishedAt],
  );
  const timedOutIds = useMemo(
    () => new Set(current?.timedOut),
    [current?.timedOut],
  );
  // What each account's first provider search took comes off its last
  // resort's box.
  const spentMs = useMemo(
    () =>
      Object.fromEntries(
        searchedIds.map((id) => [
          lastResortSearchId(id),
          spentOnProvider(started?.[id] ?? queuedAtMs[id], finishedAt[id]),
        ]),
      ),
    [searchedIds, started, queuedAtMs, finishedAt],
  );
  const { phases, toQueue, toTimeOut, nextDeadlineMs } = useMemo(
    () =>
      scheduleAccountSearches({
        accountIds: scheduledIds,
        queuedAtMs,
        finishedIds,
        timedOutIds,
        startedAtMs: started ?? NO_STARTS,
        spentMs,
        nowMs: clockMs,
      }),
    [
      scheduledIds,
      queuedAtMs,
      finishedIds,
      timedOutIds,
      started,
      spentMs,
      clockMs,
    ],
  );
  const providerAccountIds = useMemo(
    () =>
      new Set(
        searchedIds.filter(
          (id) => phases[id] === "searching" || phases[id] === "finished",
        ),
      ),
    [searchedIds, phases],
  );
  const predicate = useMemo(
    () =>
      getAccountsCuePredicate({
        searches,
        accounts: searchAccounts,
        providerAccountIds,
        unreadOnly: Boolean(intent?.parts?.unread),
        now,
        timeZone,
      }),
    [searches, searchAccounts, providerAccountIds, intent, now, timeZone],
  );
  const accountsById = useMemo(
    () => Object.fromEntries(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const providers = useMemo(
    () =>
      new Map(
        accounts.map((account) => [
          account.id,
          engineProvider(account.provider),
        ]),
      ),
    [accounts],
  );
  const state = useEngineMailThreads({
    emailAccountId,
    accountIds: searchedIds.length ? searchedIds : [emailAccountId],
    accounts: accountsById,
    providers,
    query: PREDICATE_ONLY_QUERY,
    predicate,
    enabled: natural && Boolean(predicate),
  });

  // The wider tiers, in a window of their own as for a single account, so
  // each account's first search and its widening are told apart. A tier
  // reads the local mail alone, except an account's last resort once its
  // turn comes.
  const widenedProviderIds = useMemo(
    () =>
      new Set(
        widenedIds.filter((id) => {
          const phase = phases[lastResortSearchId(id)];
          return phase === "searching" || phase === "finished";
        }),
      ),
    [widenedIds, phases],
  );
  const widenedPredicate = useMemo(
    () =>
      widenedSearches.length
        ? getAccountsWidenedPredicate({
            searches: widenedSearches,
            accounts: searchAccounts,
            lastResortIds: widenedProviderIds,
            now,
            timeZone,
          })
        : undefined,
    [widenedSearches, searchAccounts, widenedProviderIds, now, timeZone],
  );
  const wider = useEngineMailThreads({
    emailAccountId,
    accountIds: widenedIds.length ? widenedIds : [emailAccountId],
    accounts: accountsById,
    providers,
    query: PREDICATE_ONLY_QUERY,
    predicate: widenedPredicate,
    enabled: natural && Boolean(widenedPredicate),
  });

  const newStarts = [
    ...Object.entries(
      getProviderSearchStarts(state.providerSearchAccounts),
    ).filter(([id]) => providerAccountIds.has(id)),
    ...Object.entries(getProviderSearchStarts(wider.providerSearchAccounts))
      .filter(([id]) => widenedProviderIds.has(id))
      .map(([id, at]) => [lastResortSearchId(id), at] as const),
  ].filter(([id]) => started?.[id] === undefined);
  const answeredByProvider = [
    ...getFinishedProviderSearches(state.providerSearchAccounts).filter((id) =>
      providerAccountIds.has(id),
    ),
    ...getFinishedProviderSearches(wider.providerSearchAccounts)
      .filter((id) => widenedProviderIds.has(id))
      .map(lastResortSearchId),
  ].filter((id) => !finishedIds.has(id));

  useEffect(() => {
    if (nextDeadlineMs === null) return;
    // Pushed to the deadline, so a timer that fires early still lands on it.
    const timeout = setTimeout(
      () => setClockMs(Math.max(Date.now(), nextDeadlineMs)),
      Math.max(0, nextDeadlineMs - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [nextDeadlineMs]);

  // An account's turn to search its provider, or a step up its ladder,
  // changes a window's query; its rows stay while the new window loads, so
  // they don't blink out.
  const windowThreads = useHeldWhileLoading(query, state);
  const widerThreads = useHeldWhileLoading(query, wider);
  const primaryKeys = useMemo(
    () => new Set(windowThreads.map(getListThreadKey)),
    [windowThreads],
  );
  const widerNew = useMemo(
    () =>
      widerThreads.filter(
        (thread) =>
          !primaryKeys.has(getListThreadKey(thread)) &&
          widenedIds.includes(accountIdOf(thread)),
      ),
    [widerThreads, primaryKeys, widenedIds],
  );

  // Each account climbs its own ladder on its own mail: one account finding
  // plenty never stops another that found too little from widening.
  const windowSettled =
    natural &&
    Boolean(predicate) &&
    state.hasRemoteResponse &&
    !state.isLoading;
  // Tiers whose searches came to nothing to run have nothing to wait on.
  const widerSettled =
    !widenedPredicate || (wider.hasRemoteResponse && !wider.isLoading);
  const isDone = (id: string) =>
    phases[id] === "finished" || phases[id] === "timedOut";
  const primaryCounts = countByAccount(windowThreads);
  const widerCounts = countByAccount(widerNew);
  // A window holds one page shared by every account, so a busy account can
  // push another's mail past it. An account with too little in a full
  // window hasn't answered yet: it may have more just past the page.
  const ladderPrimary = Object.fromEntries(
    searchedIds.map((id) => {
      const count = primaryCounts.get(id) ?? 0;
      const cutOff = state.hasMore && count < WIDEN_BELOW_RESULTS;
      return [id, { settled: windowSettled && isDone(id) && !cutOff, count }];
    }),
  );
  const ladderWidened = Object.fromEntries(
    widenedIds.map((id) => {
      const count = widerCounts.get(id) ?? 0;
      const cutOff = Boolean(widenedPredicate && wider.hasMore) && !count;
      return [
        id,
        {
          settled:
            widerSettled &&
            !cutOff &&
            (!widenings[id]?.onProvider ||
              isDone(lastResortSearchId(id)) ||
              // Dropped unsent once the budget ran out.
              phases[lastResortSearchId(id)] === undefined),
          count,
        },
      ];
    }),
  );
  // Only an account whose own provider answered within its box, with time
  // enough left in it, may send its last resort there.
  const providerAllowedIds = new Set(
    searchedIds.filter(
      (id) =>
        phases[id] === "finished" &&
        spentMs[lastResortSearchId(id)] <=
          CUE_ACCOUNT_SEARCH_TIMEOUT_MS - MIN_LAST_RESORT_MS,
    ),
  );
  const nextWidenings = getNextAccountWidenings({
    ladders,
    widenings,
    primary: ladderPrimary,
    widened: ladderWidened,
    expired,
    providerAllowedIds,
  });

  const changesKey = JSON.stringify([
    toQueue,
    toTimeOut,
    answeredByProvider,
    newStarts,
    nextWidenings,
  ]);
  useEffect(() => {
    const [queue, timeOut, finish, starts, widen] = JSON.parse(changesKey) as [
      string[],
      string[],
      string[],
      [string, number][],
      Record<string, AccountWidening> | null,
    ];
    if (
      !query ||
      !(
        queue.length ||
        timeOut.length ||
        finish.length ||
        starts.length ||
        widen
      )
    )
      return;
    setRun((run) =>
      run?.query === query
        ? {
            ...run,
            queued: {
              ...Object.fromEntries(queue.map((id) => [id, Date.now()])),
              ...run.queued,
            },
            timedOut: [...new Set([...run.timedOut, ...timeOut])],
            finished: {
              ...Object.fromEntries(finish.map((id) => [id, Date.now()])),
              ...run.finished,
            },
            started: { ...Object.fromEntries(starts), ...run.started },
            widenings: widen ? { ...run.widenings, ...widen } : run.widenings,
          }
        : run,
    );
  }, [changesKey, query]);
  const ranking = useMemo(
    () => ({
      searches: intent?.parts
        ? getCueRankingSearch(intent.parts, { now, timeZone })
        : [],
      labels: searchAccounts.flatMap((account) => account.labels),
      now,
      timeZone,
      provider: "google" as const,
    }),
    [intent, searchAccounts, now, timeZone],
  );
  // As for one account: the first searches' matches lead, and what a wider
  // tier added competes below them.
  const liveThreads = useMemo(
    () =>
      widenedIds.length
        ? rankWithWidened(windowThreads, widerNew, ranking)
        : rankCueFoundThreads(windowThreads, ranking),
    [widenedIds, windowThreads, widerNew, ranking],
  );
  useEffect(() => {
    rowKeysRef.current = liveThreads.map(getListThreadKey);
  }, [liveThreads]);
  const frozenKeys = current?.frozenKeys ?? null;
  const orderRef = useRef<{ query: string | null; order: string[] }>({
    query: null,
    order: NO_IDS,
  });
  const held = useMemo(() => {
    if (!frozenKeys) return null;
    const order =
      orderRef.current.query === query ? orderRef.current.order : frozenKeys;
    return holdRowOrder(liveThreads, order);
  }, [liveThreads, frozenKeys, query]);
  if (held) orderRef.current = { query, order: held.order };
  const threads = held?.threads ?? liveThreads;

  // As strings, so the same accounts keep the same lists from render to render.
  const primaryPending = searchedIds.some((id) => isPending(phases[id]));
  const pendingKey = searchedIds
    .filter(
      (id) =>
        isPending(phases[id]) || isPending(phases[lastResortSearchId(id)]),
    )
    .join("\n");
  const timedOutKey = searchedIds
    .filter((id) => phases[id] === "timedOut")
    .join("\n");
  // A step about to be taken isn't an answer yet, so "found nothing" never
  // shows for a moment before Cue widens.
  const widening = widenedIds.length > 0 || nextWidenings !== null;
  const settled =
    windowSettled &&
    !pendingKey &&
    !nextWidenings &&
    (!widenedIds.length || widerSettled);
  const stage = getCueSearchStage({
    natural,
    intent: intent && {
      ...intent,
      searches: searches.map(({ search }) => search),
    },
    expired,
    primary: {
      settled: windowSettled && !primaryPending,
      count: liveThreads.length,
    },
    widening,
    widened: { settled, count: widerNew.length },
  });
  const shownWidening = useMemo(
    () => summarizeAccountWidenings(ladders, widenings),
    [ladders, widenings],
  );
  const stillSearching = useMemo(
    () => (stage === "done" ? accountsIn(accounts, pendingKey) : NO_ACCOUNTS),
    [stage, pendingKey, accounts],
  );
  const timedOut = useMemo(
    () => accountsIn(accounts, timedOutKey),
    [timedOutKey, accounts],
  );
  // What Cue ran, as each account's own search, rather than the routed
  // account's alone.
  const shownIntent = useMemo(() => {
    if (!intent) return null;
    const shown = [...new Set(searches.map(({ search }) => search))];
    return {
      ...intent,
      searches: shown,
      editableSearches: shown.map((search) =>
        readableSearch(search, intent.timeZone),
      ),
    };
  }, [intent, searches]);

  return {
    natural,
    stage,
    intent: shownIntent,
    threads,
    foundNothing: stage === "done" && settled && !liveThreads.length,
    /** The widest tier any account widened to, with each account's searches. */
    widening: shownWidening,
    // The routed account's own searches: the answer is read from its mail.
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
    /** Accounts Cue is still searching once it has shown what it found. */
    stillSearching,
    /** Accounts whose provider took too long; only their local mail shows. */
    timedOut,
  };
}

/** The rows a window showed last, kept while it loads a new query. */
function useHeldWhileLoading(
  query: string | null,
  window: { threads: ListThread[]; isLoading: boolean },
) {
  const heldRef = useRef<{ query: string | null; threads: ListThread[] }>({
    query: null,
    threads: NO_THREADS,
  });
  if (window.isLoading && heldRef.current.query === query)
    return heldRef.current.threads;
  if (!window.isLoading) heldRef.current = { query, threads: window.threads };
  return window.threads;
}

function spentOnProvider(
  startedAtMs: number | undefined,
  finishedAtMs: number | undefined,
) {
  if (startedAtMs === undefined || finishedAtMs === undefined) return 0;
  return Math.max(0, finishedAtMs - startedAtMs);
}

function accountIdOf(thread: ListThread) {
  return "account" in thread && thread.account ? thread.account.id : "";
}

function countByAccount(threads: ListThread[]) {
  const counts = new Map<string, number>();
  for (const thread of threads) {
    const id = accountIdOf(thread);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return counts;
}

function isPending(phase: AccountSearchPhase | undefined) {
  return phase === "waiting" || phase === "searching";
}

function accountsIn(accounts: AllInboxesAccount[], idsKey: string) {
  if (!idsKey) return NO_ACCOUNTS;
  const ids = new Set(idsKey.split("\n"));
  return accounts.filter((account) => ids.has(account.id));
}
