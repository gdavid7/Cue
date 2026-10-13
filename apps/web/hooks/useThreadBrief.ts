import useSWR from "swr";
import type { GetThreadBriefResponse } from "@/app/api/user/thread-brief/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useThreadBrief({
  threadId,
  emailAccountId,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
}) {
  const path =
    threadId && emailAccountId
      ? `/api/user/thread-brief?threadId=${encodeURIComponent(threadId)}`
      : null;
  return useSWR<GetThreadBriefResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    { revalidateOnFocus: false },
  );
}
