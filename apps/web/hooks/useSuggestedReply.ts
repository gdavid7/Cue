import useSWR from "swr";
import type { GetSuggestedReplyResponse } from "@/app/api/user/suggested-reply/route";
import { getAccountScopedKey } from "@/utils/swr";

/**
 * Pass `enabled: false` until the user asks: each suggestion is a model call.
 * `searchWeb` retries an abstention with what a web search finds.
 */
export function useSuggestedReply({
  threadId,
  emailAccountId,
  enabled,
  searchWeb = false,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  enabled: boolean;
  searchWeb?: boolean;
}) {
  const path =
    enabled && threadId && emailAccountId
      ? `/api/user/suggested-reply?threadId=${encodeURIComponent(threadId)}${searchWeb ? "&web=1" : ""}`
      : null;
  return useSWR<GetSuggestedReplyResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    { revalidateOnFocus: false },
  );
}
