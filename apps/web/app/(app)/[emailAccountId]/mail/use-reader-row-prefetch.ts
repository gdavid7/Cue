import { useEffect, useInsertionEffect, useRef } from "react";
import { unstable_serialize, useSWRConfig } from "swr";
import { getReaderPrefetchPlan } from "@/app/(app)/[emailAccountId]/mail/reader-prefetch-plan";
import {
  getListThreadEmailAccountId,
  getListThreadKey,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { getThreadBriefPrefetch } from "@/hooks/useThreadBrief";
import { usePremium } from "@/hooks/usePremium";
import type { EmailLabels } from "@/providers/email-label-types";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";
import { getReaderPrefetcher } from "@/utils/reader-prefetch";

export type RowHoverIntent = {
  thread: ListThread;
  insightData: ThreadInsightData | undefined;
  userLabels: EmailLabels;
};

/**
 * Row handlers that start Cue's brief of a row the mouse rests on (see
 * reader-prefetch), asked for with the account that owns the row, as the
 * reader asks. The open row is left to the reader, which is already asking.
 * Related context isn't prefetched: it spends the account's Gmail quota under
 * the same budget real opens wait on.
 */
export function useReaderRowPrefetch({
  emailAccountId,
  openThreadKey,
  listKey,
}: {
  emailAccountId: string;
  openThreadKey: string | null;
  /** The list on screen: a hover waiting on its delay doesn't outlive it. */
  listKey: string;
}) {
  const { fetcher, cache } = useSWRConfig();
  const { hasAiAccess } = usePremium();
  const open = useRef(openThreadKey);
  useInsertionEffect(() => {
    open.current = openThreadKey;
  });
  useEffect(
    () => () => getReaderPrefetcher().cancelPending(),
    [emailAccountId, listKey],
  );

  const onRowHover = useStableCallback((intent: RowHoverIntent) => {
    if (!fetcher) return;
    const { thread } = intent;
    const accountId = getListThreadEmailAccountId(thread, emailAccountId);
    const threadKey = getListThreadKey(thread);
    getReaderPrefetcher().intend({
      accountId,
      threadId: thread.id,
      request: () => {
        if (open.current === threadKey) return null;
        const plan = getReaderPrefetchPlan({ ...intent, hasAiAccess });
        if (!plan) return null;
        const request = getThreadBriefPrefetch({
          emailAccountId: accountId,
          threadId: thread.id,
          messageId: plan.messageId,
          fetcher,
        });
        // SWR already has it from an open earlier on this page.
        if (!request || cache.get(unstable_serialize(request.key))?.data)
          return null;
        return request;
      },
    });
  });
  // Leaving the row, or pressing it: an open row's reader asks for itself.
  const onRowHoverEnd = useStableCallback((threadId: string) =>
    getReaderPrefetcher().cancel(threadId),
  );

  return { onRowHover, onRowHoverEnd };
}
