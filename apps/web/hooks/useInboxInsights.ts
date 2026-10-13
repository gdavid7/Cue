import { useMemo } from "react";
import useSWR, { useSWRConfig } from "swr";
import type { GetInboxInsightsResponse } from "@/app/api/user/inbox-insights/route";
import { useAccount } from "@/providers/EmailAccountProvider";

const CHUNK_SIZE = 50;

/**
 * Insights for the rows on screen, keyed by thread id. Each thread is sent
 * with its latest message, which keys the server cache, so a new message
 * gets a fresh look and nothing else is recomputed.
 */
export function useInboxInsights(
  threads: { threadId: string; messageId: string }[],
) {
  const { emailAccountId } = useAccount();
  const { fetcher } = useSWRConfig();
  const pairs = useMemo(
    () =>
      [
        ...new Set(
          threads.map(
            (t) =>
              `${encodeURIComponent(t.threadId)}:${encodeURIComponent(t.messageId)}`,
          ),
        ),
      ].sort(),
    [threads],
  );
  const key =
    emailAccountId && pairs.length
      ? (["inbox-insights", emailAccountId, pairs.join(",")] as const)
      : null;

  return useSWR<GetInboxInsightsResponse>(
    key,
    async () => {
      if (!fetcher || !emailAccountId) {
        throw new Error("SWR fetcher is not configured");
      }
      const accountFetcher = fetcher as (
        key: [string, string],
      ) => Promise<GetInboxInsightsResponse>;
      const responses = await Promise.all(
        chunk(pairs, CHUNK_SIZE).map((items) =>
          accountFetcher([
            `/api/user/inbox-insights?items=${items.join(",")}`,
            emailAccountId,
          ]),
        ),
      );
      return {
        insights: Object.assign({}, ...responses.map((r) => r.insights)),
      };
    },
    { revalidateOnFocus: false, keepPreviousData: true },
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}
