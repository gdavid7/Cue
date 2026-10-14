"use client";

import { useMemo } from "react";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import { useCueMembership } from "@/hooks/useCueMembership";
import { useHiddenDraftMessageIds } from "@/hooks/useHiddenDraftMessageIds";
import {
  threadsQueryToPredicate,
  threadsQueryUsesCue,
  withoutHiddenDrafts,
} from "@/utils/mail-engine/threads-query";
import type { ThreadsQuery } from "@/utils/threads/validation";

export function useMailThreads({
  emailAccountId,
  query,
  enabled = true,
}: {
  emailAccountId: string;
  query: ThreadsQuery;
  enabled?: boolean;
}) {
  const hiddenDraftMessageIds = useHiddenDraftMessageIds(emailAccountId);
  const usesCue = threadsQueryUsesCue(query);
  const { membership: cueMembership, unavailable } = useCueMembership(
    enabled && usesCue,
  );
  const waitingForCue = usesCue && !cueMembership;
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
  const threads = useEngineMailThreads({
    emailAccountId,
    query,
    predicate,
    enabled: enabled && !waitingForCue,
  });
  return {
    ...threads,
    isLoading: threads.isLoading || (enabled && waitingForCue),
    /** Cue's own sorting couldn't load, so tabs that read it may be incomplete. */
    cueSortingUnavailable: usesCue && unavailable,
  };
}
