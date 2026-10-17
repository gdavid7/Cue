import groupBy from "lodash/groupBy";
import { useEffect, useMemo, useRef } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { GetInboxInsightsResponse } from "@/app/api/user/inbox-insights/route";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";
import { getHintedRetryMs } from "@/utils/swr";

const CHUNK_SIZE = 50;
// A page where only some accounts answered asks the rest again this many
// times; an account that keeps failing then waits for the next change.
const PARTIAL_RETRY_LIMIT = 5;
const PARTIAL_RETRY_BASE_MS = 5000;

type InboxInsightItem = {
  /** Where the caller looks the insight up; unique across accounts. */
  key: string;
  emailAccountId: string;
  threadId: string;
  messageId: string;
};

/**
 * Insights for the rows on screen, keyed by each item's `key`. Each thread is
 * sent with its latest message, which keys the server cache, so a new message
 * gets a fresh look and nothing else is recomputed. Rows from different
 * accounts are asked for with their own account, as the combined inbox mixes
 * them. While `enabled` is false nothing is asked for.
 */
export function useInboxInsights(
  items: InboxInsightItem[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { fetcher } = useSWRConfig();
  const requests = useMemo(() => getInboxInsightRequests(items), [items]);
  const key =
    enabled && requests.length
      ? ([
          "inbox-insights",
          requests
            .map(
              (request) =>
                `${request.emailAccountId}=${request.items.map((item) => item.pair).join(",")}`,
            )
            .join(";"),
        ] as const)
      : null;

  const result = useSWR<InboxInsightsResult>(
    key,
    async () => {
      if (!fetcher) throw new Error("SWR fetcher is not configured");
      const accountFetcher = fetcher as (
        key: [string, string],
      ) => Promise<GetInboxInsightsResponse>;
      // Each account answers on its own budget: one that is busy must not
      // take the other accounts' rows down with it.
      const settled = await Promise.allSettled(
        requests.map(async (request) => {
          const { insights } = await accountFetcher([
            `/api/user/inbox-insights?items=${request.items.map((item) => item.pair).join(",")}`,
            request.emailAccountId,
          ]);
          return request.items.flatMap((item) => {
            const insight = insights[item.threadId];
            return insight ? [[item.key, insight] as const] : [];
          });
        }),
      );
      const failures = settled.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      // Nothing to show: SWR keeps the previous rows and retries as usual.
      if (failures.length === settled.length) throw failures[0];
      return {
        insights: Object.fromEntries(
          settled.flatMap((outcome) =>
            outcome.status === "fulfilled" ? outcome.value : [],
          ),
        ),
        failure: failures[0],
      };
    },
    { revalidateOnFocus: false, keepPreviousData: true },
  );

  // SWR retries only a fetch that throws, so accounts that failed beside ones
  // that answered are asked again here, when the server's hint allows.
  const { data, mutate } = result;
  const keyId = key?.[1] ?? "";
  const partialRetries = useRef({ keyId, count: 0 });
  useEffect(() => {
    if (partialRetries.current.keyId !== keyId)
      partialRetries.current = { keyId, count: 0 };
    if (!data?.failure) {
      partialRetries.current.count = 0;
      return;
    }
    const retryCount = partialRetries.current.count + 1;
    if (retryCount > PARTIAL_RETRY_LIMIT) return;
    const delayMs =
      getHintedRetryMs(data.failure, retryCount) ??
      PARTIAL_RETRY_BASE_MS * 2 ** (retryCount - 1);
    if (delayMs === null) return;
    const timer = setTimeout(() => {
      partialRetries.current.count = retryCount;
      mutate();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [data, keyId, mutate]);

  return {
    data: data?.insights,
    error: result.error,
    isLoading: result.isLoading,
  };
}

type InboxInsightsResult = {
  insights: Record<string, ThreadInsightData>;
  /** One account's error, when only some of the accounts answered. */
  failure?: { status?: number; retryAfterMs?: number };
};

/**
 * The open thread's insight, as the reader's features ask for it. They share
 * this shape so they share one request: a different key would ask again.
 */
export function threadInsightItem({
  emailAccountId,
  threadId,
  messageId,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}): InboxInsightItem {
  return { key: threadId, emailAccountId, threadId, messageId };
}

/** One request per account and page of rows, ordered so the cache key is stable. */
export function getInboxInsightRequests(items: InboxInsightItem[]) {
  const byAccount = groupBy(items, (item) => item.emailAccountId);
  return Object.keys(byAccount)
    .sort()
    .flatMap((emailAccountId) => {
      const unique = new Map(
        byAccount[emailAccountId].map((item) => [
          item.key,
          {
            key: item.key,
            threadId: item.threadId,
            pair: `${encodeURIComponent(item.threadId)}:${encodeURIComponent(item.messageId)}`,
          },
        ]),
      );
      const sorted = [...unique.values()].sort((a, b) =>
        a.pair.localeCompare(b.pair),
      );
      return chunk(sorted, CHUNK_SIZE).map((chunkItems) => ({
        emailAccountId,
        items: chunkItems,
      }));
    });
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}
