import { useEffect } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { GetThreadBriefResponse } from "@/app/api/user/thread-brief/route";
import { createBrowserCache } from "@/utils/browser-cache";
import {
  getReaderPrefetcher,
  takeReaderPrefetchOr,
} from "@/utils/reader-prefetch";
import { getAccountScopedKey } from "@/utils/swr";

// Briefs are kept in this browser, not on the server (RD-3), under the
// conversation's newest message: a new message gets a fresh brief.
const briefs = createBrowserCache<NonNullable<GetThreadBriefResponse["brief"]>>(
  { name: "thread-brief", ttlMs: 7 * 24 * 60 * 60 * 1000, maxEntries: 300 },
);

/**
 * Cue's brief of a conversation, asked for with the account that owns it.
 * Pass `enabled: false` until the conversation is actually open: a brief this
 * browser hasn't kept is a model call. `messageId`, the newest message shown,
 * lets a reopened conversation answer from this browser alone.
 */
export function useThreadBrief({
  emailAccountId,
  threadId,
  messageId,
  enabled,
}: {
  emailAccountId: string | null | undefined;
  threadId: string | null | undefined;
  messageId: string | undefined;
  enabled: boolean;
}) {
  const key = getThreadBriefKey({
    emailAccountId,
    threadId,
    messageId,
    enabled,
  });
  const kept =
    key && emailAccountId
      ? briefs.get(emailAccountId, `${threadId}:${messageId}`)
      : undefined;
  const { fetcher } = useSWRConfig();
  const result = useSWR<GetThreadBriefResponse>(
    kept ? null : key,
    // Hovering the row may already have asked (see reader-prefetch).
    (swrKey: NonNullable<typeof key>) =>
      takeReaderPrefetchOr(swrKey, () =>
        (fetcher as (key: unknown) => Promise<GetThreadBriefResponse>)(swrKey),
      ),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      errorRetryCount: 2,
      onSuccess: (data) => {
        if (emailAccountId && threadId && messageId)
          keepBrief({ emailAccountId, threadId, messageId }, data);
      },
    },
  );
  // A hover's prefetch kept the brief before the reader opened: it was shown.
  useEffect(() => {
    if (kept && key) getReaderPrefetcher().take(key);
  }, [kept, key]);
  if (!kept) return result;
  return {
    data: { brief: kept } satisfies GetThreadBriefResponse,
    error: undefined,
    isLoading: false,
  };
}

export function getThreadBriefKey({
  emailAccountId,
  threadId,
  messageId,
  enabled,
}: Parameters<typeof useThreadBrief>[0]) {
  if (!enabled || !emailAccountId || !threadId || !messageId) return null;
  // The server ignores `messageId`; it keeps each message's brief its own.
  const params = new URLSearchParams({ threadId, messageId });
  return getAccountScopedKey(
    `/api/user/thread-brief?${params.toString()}`,
    emailAccountId,
  );
}

/**
 * The request a hover on the row starts ahead of the reader (see
 * reader-prefetch), or null when this browser already holds the brief. A
 * written brief is kept here as the reader keeps it, so one the reader never
 * took still spares the next open its model call.
 */
export function getThreadBriefPrefetch({
  emailAccountId,
  threadId,
  messageId,
  fetcher,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
  fetcher: (key: unknown) => unknown;
}) {
  if (briefs.get(emailAccountId, `${threadId}:${messageId}`)) return null;
  const key = getThreadBriefKey({
    emailAccountId,
    threadId,
    messageId,
    enabled: true,
  });
  if (!key) return null;
  return {
    key,
    run: async () => {
      const data = (await fetcher(key)) as GetThreadBriefResponse;
      keepBrief({ emailAccountId, threadId, messageId }, data);
      return data;
    },
  };
}

// Only a written brief is worth keeping: the extract costs no model call.
function keepBrief(
  {
    emailAccountId,
    threadId,
    messageId,
  }: { emailAccountId: string; threadId: string; messageId: string },
  data: GetThreadBriefResponse,
) {
  if (data.brief?.source === "ai")
    briefs.set(emailAccountId, `${threadId}:${messageId}`, data.brief);
}
