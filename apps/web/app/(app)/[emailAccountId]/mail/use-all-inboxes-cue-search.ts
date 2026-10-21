"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  type AccountCueSearch,
  type AccountSearchPhase,
  type CueSearchAccount,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getCueRankingSearch,
  getFinishedProviderSearches,
  getProviderSearchStarts,
  holdRowOrder,
  scheduleAccountSearches,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import {
  CUE_SEARCH_BUDGET_MS,
  type CueSearchIntent,
  getCueSearchStage,
  getSearchAnswerRequest,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import { rankCueFoundThreads } from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import {
  getListThreadKey,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import { useLabels } from "@/hooks/useLabels";
import type { EmailLabels } from "@/providers/email-label-types";
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
  /** Accounts whose provider search Cue has queued. */
  queued: string[];
  /** Accounts whose provider has answered, or never will. */
  finished: string[];
  /** Accounts whose provider took too long, and was stopped. */
  timedOut: string[];
  /**
   * When the engine began each account's search. Kept once seen, so a
   * window reloading for a new query doesn't restart an account's clock.
   */
  started: Record<string, number>;
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
      queued: [],
      finished: [],
      timedOut: [],
      started: {},
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

  // Which accounts' providers search now: it looks again whenever one
  // answers or begins, and when a running one's time box runs out.
  const [clockMs, setClockMs] = useState(() => Date.now());
  const started = current?.started;
  const queuedIds = useMemo(() => new Set(current?.queued), [current?.queued]);
  const finishedIds = useMemo(
    () => new Set(current?.finished),
    [current?.finished],
  );
  const timedOutIds = useMemo(
    () => new Set(current?.timedOut),
    [current?.timedOut],
  );
  const { phases, toQueue, toTimeOut, nextDeadlineMs } = useMemo(
    () =>
      scheduleAccountSearches({
        accountIds: searchedIds,
        queuedIds,
        finishedIds,
        timedOutIds,
        startedAtMs: started ?? NO_STARTS,
        nowMs: clockMs,
      }),
    [searchedIds, queuedIds, finishedIds, timedOutIds, started, clockMs],
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
  const state = useEngineMailThreads({
    emailAccountId,
    accountIds: searchedIds.length ? searchedIds : [emailAccountId],
    accounts: accountsById,
    query: PREDICATE_ONLY_QUERY,
    predicate,
    enabled: natural && Boolean(predicate),
  });

  const newStarts = Object.entries(
    getProviderSearchStarts(state.providerSearchAccounts),
  ).filter(([id]) => providerAccountIds.has(id) && started?.[id] === undefined);
  const answeredByProvider = getFinishedProviderSearches(
    state.providerSearchAccounts,
  ).filter((id) => providerAccountIds.has(id) && !finishedIds.has(id));
  const changesKey = JSON.stringify([
    toQueue,
    toTimeOut,
    answeredByProvider,
    newStarts,
  ]);
  useEffect(() => {
    const [queue, timeOut, finish, starts] = JSON.parse(changesKey) as [
      string[],
      string[],
      string[],
      [string, number][],
    ];
    if (
      !query ||
      !(queue.length || timeOut.length || finish.length || starts.length)
    )
      return;
    setRun((run) =>
      run?.query === query
        ? {
            ...run,
            queued: [...new Set([...run.queued, ...queue])],
            timedOut: [...new Set([...run.timedOut, ...timeOut])],
            finished: [...new Set([...run.finished, ...finish])],
            started: { ...Object.fromEntries(starts), ...run.started },
          }
        : run,
    );
  }, [changesKey, query]);
  useEffect(() => {
    if (nextDeadlineMs === null) return;
    // Pushed to the deadline, so a timer that fires early still lands on it.
    const timeout = setTimeout(
      () => setClockMs(Math.max(Date.now(), nextDeadlineMs)),
      Math.max(0, nextDeadlineMs - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [nextDeadlineMs]);

  // An account's turn to search its provider changes the window's query;
  // its rows stay while the new window loads, so they don't blink out.
  const heldRef = useRef<{ query: string | null; threads: ListThread[] }>({
    query: null,
    threads: NO_THREADS,
  });
  let windowThreads = state.threads;
  if (state.isLoading && heldRef.current.query === query)
    windowThreads = heldRef.current.threads;
  else if (!state.isLoading)
    heldRef.current = { query, threads: windowThreads };

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
  const liveThreads = useMemo(
    () => rankCueFoundThreads(windowThreads, ranking),
    [windowThreads, ranking],
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
  const pendingKey = searchedIds
    .filter((id) => isPending(phases[id]))
    .join("\n");
  const timedOutKey = searchedIds
    .filter((id) => phases[id] === "timedOut")
    .join("\n");
  const settled =
    natural &&
    Boolean(predicate) &&
    state.hasRemoteResponse &&
    !state.isLoading &&
    !pendingKey;
  const stage = getCueSearchStage({
    natural,
    intent: intent && {
      ...intent,
      searches: searches.map(({ search }) => search),
    },
    expired,
    primary: { settled, count: liveThreads.length },
    widening: false,
    widened: { settled: false, count: 0 },
  });
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
    widening: null,
    // The routed account's own searches: the answer is read from its mail.
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
    /** Accounts Cue is still searching once it has shown what it found. */
    stillSearching,
    /** Accounts whose provider took too long; only their local mail shows. */
    timedOut,
  };
}

function isPending(phase: AccountSearchPhase | undefined) {
  return phase === "waiting" || phase === "searching";
}

function accountsIn(accounts: AllInboxesAccount[], idsKey: string) {
  if (!idsKey) return NO_ACCOUNTS;
  const ids = new Set(idsKey.split("\n"));
  return accounts.filter((account) => ids.has(account.id));
}
