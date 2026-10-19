import useSWR from "swr";
import type { GetThreadContextResponse } from "@/app/api/user/thread-context/route";
import { createBrowserCache } from "@/utils/browser-cache";
import { getAccountScopedKey } from "@/utils/swr";

// The server keeps no context (RD-3), and gathering it reads mail, calendar,
// connected apps and linked pages, so a conversation reopened within minutes
// is answered from this browser.
const contexts = createBrowserCache<GetThreadContextResponse>({
  name: "thread-context",
  ttlMs: 10 * 60 * 1000,
  maxEntries: 50,
});

export function useThreadContext({
  threadId,
  emailAccountId,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
}) {
  const kept =
    threadId && emailAccountId
      ? contexts.get(emailAccountId, threadId)
      : undefined;
  const path =
    threadId && emailAccountId && !kept
      ? `/api/user/thread-context?threadId=${encodeURIComponent(threadId)}`
      : null;
  const result = useSWR<GetThreadContextResponse>(
    path ? getAccountScopedKey(path, emailAccountId) : null,
    {
      revalidateOnFocus: false,
      onSuccess: (data) => {
        if (threadId && emailAccountId)
          contexts.set(emailAccountId, threadId, data);
      },
    },
  );
  if (!kept) return result;
  return { ...result, data: kept, error: undefined, isLoading: false };
}
