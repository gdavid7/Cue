import useSWR, { useSWRConfig } from "swr";
import type {
  GetSuggestedReplyResponse,
  SuggestedReplyBody,
} from "@/app/api/user/suggested-reply/route";
import { getAccountScopedKey } from "@/utils/swr";
import {
  keptSuggestions,
  suggestionKey,
} from "@/utils/thread-context/suggested-reply-store";

/**
 * Pass `enabled: false` until the user asks: a suggestion this browser hasn't
 * kept is a model call. `messageId`, the newest message shown, keys what this
 * browser keeps (the server keeps nothing, RD-3). `searchWeb` retries an
 * abstention with what a web search finds for its `webQuery`. `keptOnly`
 * reads back what this browser kept and never asks the server. `context`,
 * the thread's context the reader already has, spares the server gathering
 * it again.
 */
export function useSuggestedReply({
  threadId,
  emailAccountId,
  messageId,
  enabled,
  searchWeb = false,
  webQuery,
  keptOnly = false,
  context,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  messageId?: string;
  enabled: boolean;
  searchWeb?: boolean;
  webQuery?: string;
  keptOnly?: boolean;
  context?: SuggestedReplyBody["context"];
}) {
  const { fetcher } = useSWRConfig();
  const keptKey =
    threadId && messageId
      ? suggestionKey({ threadId, messageId, web: searchWeb })
      : null;
  const kept =
    enabled && emailAccountId && keptKey
      ? keptSuggestions.get(emailAccountId, keptKey)
      : undefined;

  const params = new URLSearchParams();
  if (threadId) params.set("threadId", threadId);
  // The server ignores `messageId`; it keeps each message's answer its own.
  if (messageId) params.set("messageId", messageId);
  if (searchWeb) params.set("web", "1");
  if (searchWeb && webQuery) params.set("webQuery", webQuery);
  const path =
    enabled && !keptOnly && !kept && threadId && emailAccountId
      ? `/api/user/suggested-reply?${params.toString()}`
      : null;
  const result = useSWR<GetSuggestedReplyResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    (key: unknown) =>
      fetcher?.(key, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ context } satisfies SuggestedReplyBody),
      }) as Promise<GetSuggestedReplyResponse>,
    {
      revalidateOnFocus: false,
      // Each retry waits out the server's Retry-After; past two the reader
      // says it couldn't and offers to try again.
      errorRetryCount: 2,
      onSuccess: (data) => {
        const status = data.suggestion?.status;
        if (
          emailAccountId &&
          keptKey &&
          (status === "suggested" || status === "insufficient")
        )
          keptSuggestions.set(emailAccountId, keptKey, data);
      },
    },
  );
  if (!kept) return result;
  return { data: kept, error: undefined, isLoading: false, mutate: undefined };
}
