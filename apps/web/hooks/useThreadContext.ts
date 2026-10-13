import useSWR from "swr";
import type { GetThreadContextResponse } from "@/app/api/user/thread-context/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useThreadContext({
  threadId,
  emailAccountId,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
}) {
  const path =
    threadId && emailAccountId
      ? `/api/user/thread-context?threadId=${encodeURIComponent(threadId)}`
      : null;
  return useSWR<GetThreadContextResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    { revalidateOnFocus: false },
  );
}
