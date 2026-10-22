"use client";

import { useMemo } from "react";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import { useCueMembership } from "@/hooks/useCueMembership";
import { useHiddenDraftMessageIds } from "@/hooks/useHiddenDraftMessageIds";
import { useLabels } from "@/hooks/useLabels";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  type SearchQueryContext,
  searchProvider,
} from "@/utils/mail-search/search-query-predicate";
import { engineProvider } from "@/utils/mail-engine/engine-accounts";
import {
  threadsQueryToPredicate,
  threadsQueryUsesCue,
  withoutHiddenDrafts,
} from "@/utils/mail-engine/threads-query";
import type { ThreadsQuery } from "@/utils/threads/validation";

export function useMailThreads({
  emailAccountId,
  query,
  providerSearch,
  enabled = true,
}: {
  emailAccountId: string;
  query: ThreadsQuery;
  /** False while a search is still being typed: it reads local mail only. */
  providerSearch?: boolean;
  enabled?: boolean;
}) {
  const hiddenDraftMessageIds = useHiddenDraftMessageIds(emailAccountId);
  const usesCue = threadsQueryUsesCue(query);
  const { membership: cueMembership, unavailable } = useCueMembership(
    enabled && usesCue,
  );
  const waitingForCue = usesCue && !cueMembership;
  const { userLabels } = useLabels();
  const { provider } = useAccount();
  // Only a search reads labels and syntax; other views keep their predicate
  // while labels load.
  const search = useMemo<Partial<SearchQueryContext> | undefined>(
    () =>
      query.q
        ? {
            labels: userLabels,
            provider: searchProvider(provider),
          }
        : undefined,
    [query.q, userLabels, provider],
  );
  const predicate = useMemo<MailPredicate | undefined>(() => {
    if (usesCue) return threadsQueryToPredicate(query, cueMembership);
    // A conversation stays in Drafts only through drafts that aren't hidden.
    if (query.type === "draft" && hiddenDraftMessageIds.length) {
      return withoutHiddenDrafts(
        threadsQueryToPredicate(query),
        hiddenDraftMessageIds,
      );
    }
    return;
  }, [query, usesCue, cueMembership, hiddenDraftMessageIds]);
  const providers = useMemo(
    () => new Map(provider ? [[emailAccountId, engineProvider(provider)]] : []),
    [emailAccountId, provider],
  );
  const threads = useEngineMailThreads({
    emailAccountId,
    providers,
    query,
    predicate,
    search,
    providerSearch,
    enabled: enabled && !waitingForCue,
  });
  return {
    ...threads,
    isLoading: threads.isLoading || (enabled && waitingForCue),
    /** Cue's own sorting couldn't load, so tabs that read it may be incomplete. */
    cueSortingUnavailable: usesCue && unavailable,
  };
}
