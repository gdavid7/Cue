import useSWR from "swr";
import type { GetSuggestedReplyResponse } from "@/app/api/user/suggested-reply/route";
import { getAccountScopedKey } from "@/utils/swr";

/**
 * Pass `enabled: false` until the user asks: each suggestion is a model call.
 * `searchWeb` retries an abstention with what a web search finds.
 * `cachedFor` (a message id) only reads back the reply Cue already worked out
 * for that message, and never makes a model call.
 */
export function useSuggestedReply({
  threadId,
  emailAccountId,
  enabled,
  searchWeb = false,
  cachedFor,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  enabled: boolean;
  searchWeb?: boolean;
  cachedFor?: string;
}) {
  const params = new URLSearchParams();
  if (threadId) params.set("threadId", threadId);
  if (searchWeb) params.set("web", "1");
  if (cachedFor) params.set("cachedFor", cachedFor);
  const path =
    enabled && threadId && emailAccountId
      ? `/api/user/suggested-reply?${params.toString()}`
      : null;
  return useSWR<GetSuggestedReplyResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    { revalidateOnFocus: false },
  );
}
