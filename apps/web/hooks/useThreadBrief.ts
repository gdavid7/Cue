import useSWR from "swr";
import type { GetThreadBriefResponse } from "@/app/api/user/thread-brief/route";
import { getAccountScopedKey } from "@/utils/swr";

/**
 * Cue's brief of a conversation, asked for with the account that owns it.
 * Pass `enabled: false` until the conversation is actually open: an uncached
 * brief is a model call. `messageId`, the newest message shown, lets the
 * server answer a reopened conversation from its cache alone.
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
  return useSWR<GetThreadBriefResponse>(
    getThreadBriefKey({ emailAccountId, threadId, messageId, enabled }),
    { revalidateOnFocus: false, revalidateOnReconnect: false },
  );
}

export function getThreadBriefKey({
  emailAccountId,
  threadId,
  messageId,
  enabled,
}: Parameters<typeof useThreadBrief>[0]) {
  if (!enabled || !emailAccountId || !threadId || !messageId) return null;
  const params = new URLSearchParams({ threadId, messageId });
  return getAccountScopedKey(
    `/api/user/thread-brief?${params.toString()}`,
    emailAccountId,
  );
}
