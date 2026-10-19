import useSWR from "swr";
import type { GetThreadBriefResponse } from "@/app/api/user/thread-brief/route";
import { createBrowserCache } from "@/utils/browser-cache";
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
  const result = useSWR<GetThreadBriefResponse>(kept ? null : key, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    errorRetryCount: 2,
    onSuccess: (data) => {
      // Only a written brief is worth keeping: the extract costs no model call.
      if (data.brief?.source === "ai" && emailAccountId)
        briefs.set(emailAccountId, `${threadId}:${messageId}`, data.brief);
    },
  });
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
