"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import useSWR from "swr";
import {
  CUE_SEARCH_BUDGET_MS,
  type CueSearchIntent,
  type CueWidening,
  getCueSearchStage,
  getNextWidening,
  getSearchAnswerRequest,
  getWideningLadder,
  keepFrozenRows,
  localOnly,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import {
  type CueRankingContext,
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
import { useAccount } from "@/providers/EmailAccountProvider";
import { searchProvider } from "@/utils/mail-search/search-query-predicate";
import { looksLikeNaturalLanguage } from "@/utils/mail-search/natural-language-search";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import { swrFetcher } from "@/providers/swr-fetcher";
import type { ThreadsQuery } from "@/utils/threads/validation";

const SEARCH_INTENT_PATH = "/api/user/search-intent";
const NO_SEARCHES: string[] = [];
// The predicate carries the searches; the query only names the window.
const PREDICATE_ONLY_QUERY: ThreadsQuery = { q: "" };

type Budget = {
  /** Which run of the timer this is, so a stale one never lands. */
  run: number;
  query: string;
  expired: boolean;
  /** The model hadn't answered when the budget ran out. */
  readingLate: boolean;
  /** The rows on screen when the budget ran out. */
  frozenKeys: string[] | null;
};

/**
 * The AI path of a committed search typed as a sentence: Cue reads it into a
 * search, runs it on the local mail with the provider as fallback, and when
 * it finds too little climbs a ladder of wider local searches to the first
 * that finds more. What it finds is ranked by how well it fits the search.
 * The plain results never wait on it, and keep their own order.
 */
export function useCueSearch({
  emailAccountId,
  query,
  enabled,
}: {
  emailAccountId: string;
  /** The committed search, never the text being typed. */
  query: string | null;
  /** Off for users without AI and for views across accounts. */
  enabled: boolean;
}) {
  const natural = Boolean(enabled && query && looksLikeNaturalLanguage(query));
  // The browser already holds the labels, so they go with the search rather
  // than the route asking the provider for them on every search. They stay
  // out of the key: a label added later doesn't read the search again.
  const { userLabels, isLoading: labelsLoading } = useLabels();
  // A ref, not part of the key, on purpose: a new label mustn't re-read the search.
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

  // The budget runs from commit. A reading that lands after it is dropped,
  // and so is mail found after it, so nothing arrives long after the user
  // has started reading.
  const answeredRef = useRef(answered);
  const rowKeysRef = useRef<string[]>([]);
  const runRef = useRef(0);
  const [budget, setBudget] = useState<Budget | null>(null);
  useEffect(() => {
    answeredRef.current = answered;
  }, [answered]);
  useEffect(() => {
    if (!natural || !query) return;
    runRef.current += 1;
    const run = runRef.current;
    setBudget({
      run,
      query,
      expired: false,
      readingLate: false,
      frozenKeys: null,
    });
    const timeout = setTimeout(() => {
      setBudget((current) =>
        current?.run === run
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
  // Read only for this search, so another search's budget never applies.
  const current = budget?.query === query ? budget : null;
  const expired = Boolean(current?.expired);
  let intent: CueSearchIntent | null | undefined;
  if (answered && !current?.readingLate) intent = data ?? null;

  const searches = intent?.searches ?? NO_SEARCHES;
  const timeZone = intent?.timeZone;
  const { provider } = useAccount();
  // Once per reading, so a wider window's searches, and recency, hold still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading is a new now
  const now = useMemo(() => new Date(), [searches]);
  const ranking = useMemo<CueRankingContext>(
    () => ({
      searches,
      labels: userLabels,
      now,
      timeZone,
      provider: searchProvider(provider),
    }),
    [searches, userLabels, now, timeZone, provider],
  );
  const ladder = useMemo(
    () => getWideningLadder(searches, ranking),
    [searches, ranking],
  );
  const primary = useCueFoundThreads({
    emailAccountId,
    searches,
    timeZone,
    unreadOnly: Boolean(intent?.unreadOnly),
    providerSearches: "all",
    enabled: natural && searches.length > 0,
  });

  const [widenedTo, setWidenedTo] = useState<{
    query: string;
    step: number;
    onProvider: boolean;
  } | null>(null);
  const wideningState = widenedTo?.query === query ? widenedTo : null;
  const step = wideningState?.step ?? null;
  const onProvider = Boolean(wideningState?.onProvider);
  const widening = useMemo<CueWidening | null>(() => {
    const tier = step === null ? undefined : ladder[step];
    return tier ? { ...tier, onProvider } : null;
  }, [ladder, step, onProvider]);
  // Each tier reads the local mail alone, so climbing the ladder stays fast;
  // the first search already asked the provider. Only when nothing at all
  // turns up does the last tier go to the provider, as one search: its
  // first, with the rest still read locally. Unread is a narrowing
  // condition, which widening drops.
  const wider = useCueFoundThreads({
    emailAccountId,
    searches: widening?.searches ?? NO_SEARCHES,
    timeZone,
    unreadOnly: false,
    providerSearches: onProvider ? "first" : "none",
    enabled: Boolean(widening),
  });
  const primaryKeys = useMemo(
    () => new Set(primary.threads.map(getListThreadKey)),
    [primary.threads],
  );
  const widerNew = useMemo(
    () =>
      wider.threads.filter(
        (thread) => !primaryKeys.has(getListThreadKey(thread)),
      ),
    [wider.threads, primaryKeys],
  );

  const stage = getCueSearchStage({
    natural,
    intent,
    expired,
    primary: primary.window,
    widening: Boolean(widening),
    widened: wider.window,
  });
  const next =
    stage === "done" || stage === "widening"
      ? getNextWidening(
          {
            primary: primary.window,
            widened: { settled: wider.window.settled, count: widerNew.length },
            ladderLength: ladder.length,
            expired,
          },
          step === null ? null : { step, onProvider },
          { mayAskProvider: true },
        )
      : null;
  if (query && next) setWidenedTo({ query, ...next });

  const liveThreads = useMemo(
    () =>
      widening
        ? rankWithWidened(primary.threads, widerNew, ranking)
        : rankCueFoundThreads(primary.threads, ranking),
    [widening, primary.threads, widerNew, ranking],
  );
  useEffect(() => {
    rowKeysRef.current = liveThreads.map(getListThreadKey);
  }, [liveThreads]);
  const frozenKeys = current?.frozenKeys ?? null;
  const threads = useMemo(
    () => keepFrozenRows(liveThreads, frozenKeys),
    [liveThreads, frozenKeys],
  );
  const settled = widening ? wider.window.settled : primary.window.settled;

  return {
    /** Whether this search takes the AI path at all, even if it comes to nothing. */
    natural,
    stage,
    intent: intent ?? null,
    threads,
    /** Cue's searches have all answered, and found nothing. */
    foundNothing: stage === "done" && settled && !liveThreads.length,
    /** The tier Cue widened to after the first searches found too little. */
    widening,
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
  };
}

/** Mail matching any of `searches`, from the local store and the provider. */
function useCueFoundThreads({
  emailAccountId,
  searches,
  timeZone,
  unreadOnly,
  providerSearches,
  enabled,
}: {
  emailAccountId: string;
  searches: string[];
  /** The account's, which Outlook's received dates are read in. */
  timeZone: string | undefined;
  /** Keeps only unread mail, for a provider whose search can't. */
  unreadOnly: boolean;
  /** Which of `searches` also go to the provider; "none" reads the local mail alone. */
  providerSearches: "all" | "first" | "none";
  enabled: boolean;
}): { threads: ListThread[]; window: { settled: boolean; count: number } } {
  const { userLabels } = useLabels();
  const { provider } = useAccount();
  const predicate = useMemo<MailPredicate | undefined>(() => {
    const context = {
      labels: userLabels,
      provider: searchProvider(provider),
      timeZone,
    };
    const predicates = searches.map((q, index) => {
      const predicate = threadsQueryToPredicate({ q }, undefined, context);
      return providerSearches === "first" && index > 0
        ? localOnly(predicate)
        : predicate;
    });
    const matching: MailPredicate | undefined =
      predicates.length < 2 ? predicates[0] : { kind: "any", predicates };
    // Outside the search, so the provider's matches are filtered too.
    if (!matching || !unreadOnly) return matching;
    return {
      kind: "all",
      predicates: [matching, { kind: "read", value: false }],
    };
  }, [searches, timeZone, unreadOnly, userLabels, provider, providerSearches]);
  const state = useEngineMailThreads({
    emailAccountId,
    query: PREDICATE_ONLY_QUERY,
    predicate,
    providerSearch: providerSearches !== "none",
    enabled: enabled && !!predicate,
  });
  const settled =
    enabled &&
    state.hasRemoteResponse &&
    !state.isLoading &&
    !state.providerSearchPending;
  return {
    threads: state.threads,
    window: { settled, count: state.threads.length },
  };
}
