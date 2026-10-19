import useSWR from "swr";
import type { GetSuggestedReplyResponse } from "@/app/api/user/suggested-reply/route";
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
 * reads back what this browser kept and never asks the server.
 */
export function useSuggestedReply({
  threadId,
  emailAccountId,
  messageId,
  enabled,
  searchWeb = false,
  webQuery,
  keptOnly = false,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  messageId?: string;
  enabled: boolean;
  searchWeb?: boolean;
  webQuery?: string;
  keptOnly?: boolean;
}) {
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
    {
      revalidateOnFocus: false,
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
  return { data: kept, error: undefined, isLoading: false };
}
