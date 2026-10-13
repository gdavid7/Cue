import useSWR from "swr";
import type { GetSuggestedReplyResponse } from "@/app/api/user/suggested-reply/route";
import { getAccountScopedKey } from "@/utils/swr";

/** Pass `enabled: false` until the user asks: each suggestion is a model call. */
export function useSuggestedReply({
  threadId,
  emailAccountId,
  enabled,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  enabled: boolean;
}) {
  const path =
    enabled && threadId && emailAccountId
      ? `/api/user/suggested-reply?threadId=${encodeURIComponent(threadId)}`
      : null;
  return useSWR<GetSuggestedReplyResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    { revalidateOnFocus: false },
  );
}
