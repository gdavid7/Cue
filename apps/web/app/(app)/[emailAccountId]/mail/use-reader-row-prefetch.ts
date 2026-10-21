import { useInsertionEffect, useRef } from "react";
import { type Key, unstable_serialize, useSWRConfig } from "swr";
import { getReaderPrefetchPlan } from "@/app/(app)/[emailAccountId]/mail/reader-prefetch-plan";
import {
  getListThreadEmailAccountId,
  getListThreadKey,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { getThreadBriefKey, isThreadBriefKept } from "@/hooks/useThreadBrief";
import {
  getThreadContextKey,
  isThreadContextKept,
} from "@/hooks/useThreadContext";
import { usePremium } from "@/hooks/usePremium";
import type { EmailLabels } from "@/providers/email-label-types";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";
import {
  getReaderPrefetcher,
  type PrefetchKind,
} from "@/utils/reader-prefetch";

export type RowHoverIntent = {
  thread: ListThread;
  insightData: ThreadInsightData | undefined;
  userLabels: EmailLabels;
  accountEmail: string;
};

/**
 * Row handlers that start the reader's brief and related context for a row
 * the mouse rests on (see reader-prefetch). The open row is left to the
 * reader, which is already asking.
 */
export function useReaderRowPrefetch({
  emailAccountId,
  openThreadKey,
}: {
  emailAccountId: string;
  openThreadKey: string | null;
}) {
  const { fetcher, cache } = useSWRConfig();
  const { hasAiAccess } = usePremium();
  const open = useRef(openThreadKey);
  useInsertionEffect(() => {
    open.current = openThreadKey;
  });

  const onRowHover = useStableCallback((intent: RowHoverIntent) => {
    if (!fetcher) return;
    const { thread } = intent;
    const accountId = getListThreadEmailAccountId(thread, emailAccountId);
    const threadKey = getListThreadKey(thread);
    const held = (key: Key) =>
      Boolean(cache.get(unstable_serialize(key))?.data);
    getReaderPrefetcher().intend({
      accountId,
      threadId: thread.id,
      requests: () => {
        if (open.current === threadKey) return [];
        const plan = getReaderPrefetchPlan({ ...intent, hasAiAccess });
        if (!plan) return [];
        const requests: {
          kind: PrefetchKind;
          key: Key;
          run: () => Promise<unknown>;
        }[] = [];
        const briefKey = getThreadBriefKey({
          emailAccountId: accountId,
          threadId: thread.id,
          messageId: plan.messageId,
          enabled: plan.brief,
        });
        if (
          briefKey &&
          !held(briefKey) &&
          !isThreadBriefKept({
            emailAccountId: accountId,
            threadId: thread.id,
            messageId: plan.messageId,
          })
        )
          requests.push({
            kind: "brief",
            key: briefKey,
            run: async () => fetcher(briefKey),
          });
        const contextKey = plan.context
          ? getThreadContextKey(thread.id, accountId)
          : null;
        if (
          contextKey &&
          !held(contextKey) &&
          !isThreadContextKept(accountId, thread.id)
        )
          requests.push({
            kind: "context",
            key: contextKey,
            run: async () => fetcher(contextKey),
          });
        return requests;
      },
    });
  });
  // Leaving the row, or pressing it: an open row's reader asks for itself.
  const onRowHoverEnd = useStableCallback((threadId: string) =>
    getReaderPrefetcher().cancel(threadId),
  );

  return { onRowHover, onRowHoverEnd };
}
