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
  shouldWidenCueSearch,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import { useLabels } from "@/hooks/useLabels";
import { useAccount } from "@/providers/EmailAccountProvider";
import { searchProvider } from "@/utils/mail-search/search-query-predicate";
import { looksLikeNaturalLanguage } from "@/utils/mail-search/natural-language-search";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import { getAccountScopedKey } from "@/utils/swr";

const NO_SEARCHES: string[] = [];

/**
 * The AI path of a committed search typed as a sentence: Cue reads it into
 * searches, runs them on the local mail with the provider as fallback, and
 * widens once when they find too little. The plain results never wait on it.
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
  const { data, error } = useSWR<GetSearchIntentResponse>(
    natural && query
      ? getAccountScopedKey(
          `/api/user/search-intent?q=${encodeURIComponent(query)}`,
          emailAccountId,
        )
      : null,
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const answered = data !== undefined || error !== undefined;

  // The budget runs from commit. A reading that lands after it is dropped,
  // so results never arrive long after the user moved on.
  const answeredRef = useRef(answered);
  useEffect(() => {
    answeredRef.current = answered;
  }, [answered]);
  const [budget, setBudget] = useState<{
    query: string;
    readingLate: boolean;
  } | null>(null);
  useEffect(() => {
    if (!natural || !query) return;
    // Coming back to a search starts its budget again.
    setBudget(null);
    const timeout = setTimeout(
      () => setBudget({ query, readingLate: !answeredRef.current }),
      CUE_SEARCH_BUDGET_MS,
    );
    return () => clearTimeout(timeout);
  }, [natural, query]);
  const expired = budget?.query === query;
  const readingLate = expired && budget?.readingLate;
  let intent: CueSearchIntent | null | undefined;
  if (answered && !readingLate) intent = data ?? null;

  const searches = intent?.searches ?? NO_SEARCHES;
  const widerSearches = useMemo(() => getWiderSearches(searches), [searches]);
  const primary = useCueFoundThreads({
    emailAccountId,
    searches,
    enabled: natural && searches.length > 0,
  });

  const [widenedFor, setWidenedFor] = useState<string | null>(null);
  const widening = widenedFor === query;
  const wider = useCueFoundThreads({
    emailAccountId,
    searches: widerSearches,
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

  // The first searches' matches lead; the wider search only adds to them.
  const threads = useMemo(() => {
    if (!widening) return primary.threads;
    const seen = new Set(primary.threads.map((thread) => thread.id));
    return [
      ...primary.threads,
      ...wider.threads.filter((thread) => !seen.has(thread.id)),
    ];
  }, [widening, primary.threads, wider.threads]);

  return {
    stage,
    intent: intent ?? null,
    threads,
    /** The wider searches Cue ran after the first found too little. */
    widerSearches: widening ? widerSearches : NO_SEARCHES,
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
  };
}

/** Mail matching any of `searches`, from the local store and the provider. */
function useCueFoundThreads({
  emailAccountId,
  searches,
  enabled,
}: {
  emailAccountId: string;
  searches: string[];
  enabled: boolean;
}): { threads: ListThread[]; window: { settled: boolean; count: number } } {
  const { userLabels } = useLabels();
  const { provider } = useAccount();
  const query = useMemo(() => ({ q: searches.join(" OR ") }), [searches]);
  const predicate = useMemo<MailPredicate | undefined>(() => {
    const context = {
      labels: userLabels,
      provider: searchProvider(provider),
    };
    const predicates = searches.map((q) =>
      threadsQueryToPredicate({ q }, undefined, context),
    );
    if (predicates.length < 2) return predicates[0];
    return { kind: "any", predicates };
  }, [searches, userLabels, provider]);
  const state = useEngineMailThreads({
    emailAccountId,
    query,
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
