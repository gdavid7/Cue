"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import useSWR from "swr";
import {
  CUE_SEARCH_BUDGET_MS,
  type CueSearchIntent,
  getCueSearchStage,
  getSearchAnswerRequest,
  getWiderSearches,
  keepFrozenRows,
  shouldWidenCueSearch,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
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
 * search, runs it on the local mail with the provider as fallback, and widens
 * once when it finds too little. The plain results never wait on it.
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
  const widerSearches = useMemo(() => getWiderSearches(searches), [searches]);
  const primary = useCueFoundThreads({
    emailAccountId,
    searches,
    timeZone: intent?.timeZone,
    unreadOnly: Boolean(intent?.unreadOnly),
    enabled: natural && searches.length > 0,
  });

  const [widenedFor, setWidenedFor] = useState<string | null>(null);
  const widening = widenedFor === query;
  // Widening drops narrowing conditions, unread among them.
  const wider = useCueFoundThreads({
    emailAccountId,
    searches: widerSearches,
    timeZone: intent?.timeZone,
    unreadOnly: false,
    enabled: widening,
  });

  const stage = getCueSearchStage({
    natural,
    intent,
    expired,
    primary: primary.window,
    widening,
    widened: wider.window,
  });
  if (
    !widening &&
    query &&
    shouldWidenCueSearch({
      stage,
      primary: primary.window,
      widerSearches,
      expired,
    })
  )
    setWidenedFor(query);

  // The first search's matches lead; the wider search only adds to them.
  const liveThreads = useMemo(() => {
    if (!widening) return primary.threads;
    const seen = new Set(primary.threads.map(getListThreadKey));
    return [
      ...primary.threads,
      ...wider.threads.filter((thread) => !seen.has(getListThreadKey(thread))),
    ];
  }, [widening, primary.threads, wider.threads]);
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
    /** The wider searches Cue ran after the first found too little. */
    widerSearches: widening ? widerSearches : NO_SEARCHES,
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
  };
}

/** Mail matching any of `searches`, from the local store and the provider. */
function useCueFoundThreads({
  emailAccountId,
  searches,
  timeZone,
  unreadOnly,
  enabled,
}: {
  emailAccountId: string;
  searches: string[];
  /** The account's, which Outlook's received dates are read in. */
  timeZone: string | undefined;
  /** Keeps only unread mail, for a provider whose search can't. */
  unreadOnly: boolean;
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
    const predicates = searches.map((q) =>
      threadsQueryToPredicate({ q }, undefined, context),
    );
    const matching: MailPredicate | undefined =
      predicates.length < 2 ? predicates[0] : { kind: "any", predicates };
    // Outside the search, so the provider's matches are filtered too.
    if (!matching || !unreadOnly) return matching;
    return {
      kind: "all",
      predicates: [matching, { kind: "read", value: false }],
    };
  }, [searches, timeZone, unreadOnly, userLabels, provider]);
  const state = useEngineMailThreads({
    emailAccountId,
    query: PREDICATE_ONLY_QUERY,
    predicate,
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
