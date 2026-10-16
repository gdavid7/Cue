import groupBy from "lodash/groupBy";
import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { GetInboxInsightsResponse } from "@/app/api/user/inbox-insights/route";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

const CHUNK_SIZE = 50;

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

  return useSWR<Record<string, ThreadInsightData>>(
    key,
    async () => {
      if (!fetcher) throw new Error("SWR fetcher is not configured");
      const accountFetcher = fetcher as (
        key: [string, string],
      ) => Promise<GetInboxInsightsResponse>;
      const responses = await Promise.all(
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
      return Object.fromEntries(responses.flat());
    },
    { revalidateOnFocus: false, keepPreviousData: true },
  );
}

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
