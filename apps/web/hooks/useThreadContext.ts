import useSWR, { useSWRConfig } from "swr";
import { createBrowserCache } from "@/utils/browser-cache";
import { takeReaderPrefetchOr } from "@/utils/reader-prefetch";
import { getAccountScopedKey } from "@/utils/swr";
import type { ThreadContextItem } from "@/utils/thread-context/get-thread-context";

type ShownContext = { items: (ThreadContextItem & { text?: string })[] };

// The server keeps no context (RD-3), and gathering it reads mail, calendar,
// connected apps and linked pages, so a conversation reopened within minutes
// is answered from this browser. What it keeps is what the panel shows: the
// items' text (and a linked page's words) stay in memory for this page only.
const contexts = createBrowserCache<ShownContext>({
  name: "thread-context",
  ttlMs: 10 * 60 * 1000,
  maxEntries: 50,
});

/**
 * The thread's related context. Items carry their `text` when it was fetched
 * on this page, so a suggested reply can reuse it; read back from this
 * browser, they carry only what the panel shows.
 */
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
  const { fetcher } = useSWRConfig();
  const key = getThreadContextKey(threadId, emailAccountId);
  // Fetched earlier on this page, SWR's copy (with its text) wins over the
  // kept one; otherwise the kept one stands and nothing is fetched. Hovering
  // the row may already have asked (see reader-prefetch).
  return useSWR<ShownContext>(
    key,
    (swrKey: NonNullable<typeof key>) =>
      takeReaderPrefetchOr(swrKey, () =>
        (fetcher as (key: unknown) => Promise<ShownContext>)(swrKey),
      ),
    {
      fallbackData: kept,
      revalidateOnMount: !kept,
      revalidateIfStale: !kept,
      revalidateOnFocus: false,
      errorRetryCount: 2,
      onSuccess: (data) => {
        if (threadId && emailAccountId)
          contexts.set(emailAccountId, threadId, shown(data));
      },
    },
  );
}

export function getThreadContextKey(
  threadId: string | null | undefined,
  emailAccountId: string | null | undefined,
) {
  if (!threadId || !emailAccountId) return null;
  return getAccountScopedKey(
    `/api/user/thread-context?threadId=${encodeURIComponent(threadId)}`,
    emailAccountId,
  );
}

/** Whether this browser already holds the thread's context. */
export function isThreadContextKept(emailAccountId: string, threadId: string) {
  return Boolean(contexts.get(emailAccountId, threadId));
}

/** The items' text read back, only when every item has it. */
export function contextWithText(context: ShownContext | undefined) {
  const items = context?.items;
  if (!items?.every(hasText)) return;
  return items;
}

function hasText<T extends { text?: string }>(
  item: T,
): item is T & { text: string } {
  return typeof item.text === "string";
}

function shown(data: ShownContext): ShownContext {
  return {
    items: data.items.map(({ text: _text, ...item }) =>
      item.kind === "web" ? { ...item, snippet: "" } : item,
    ),
  };
}
