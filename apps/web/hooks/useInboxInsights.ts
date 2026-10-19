import groupBy from "lodash/groupBy";
import { useCallback, useMemo } from "react";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";
import type { GetInboxInsightsResponse } from "@/app/api/user/inbox-insights/route";
import { createBrowserCache } from "@/utils/browser-cache";
import type {
  InboxInsightExtraction,
  ThreadInsightData,
} from "@/utils/inbox-insights/get-inbox-insights";
import { nextMeetingWith } from "@/utils/inbox-insights/meeting-match";
import { getRetryHint } from "@/utils/swr";
import { keptSuggestionFor } from "@/utils/thread-context/suggested-reply-store";

const CHUNK_SIZE = 50;
// A page where only some accounts answered asks the rest again this many
// times; an account that keeps failing then waits for the next change.
const PARTIAL_RETRY_LIMIT = 5;
const PARTIAL_RETRY_BASE_MS = 5000;

// What Cue read from each email, kept in this browser for as long as the
// email could still be on screen: the server keeps none of it (RD-3).
const extractions = createBrowserCache<InboxInsightExtraction>({
  name: "inbox-insight",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
});

type InboxInsightItem = {
  /** Where the caller looks the insight up; unique across accounts. */
  key: string;
  emailAccountId: string;
  threadId: string;
  messageId: string;
};

/**
 * Insights for the rows on screen, keyed by each item's `key`. Each thread is
 * sent with its latest message; what this browser already read from a
 * message is kept here and named to the server, so a new message gets a
 * fresh look and nothing else is recomputed. Rows from different
 * accounts are asked for with their own account, as the combined inbox mixes
 * them. While `enabled` is false nothing is asked for.
 */
export function useInboxInsights(
  items: InboxInsightItem[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { fetcher, cache } = useSWRConfig();
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

  // SWR retries only a fetch that throws, so accounts that failed beside ones
  // that answered are asked again by polling, as the server's hint allows.
  // SWR reads the interval when polling starts and after each poll, so the
  // function changes only when a failure appears or clears, which starts or
  // stops polling without resetting a wait on every render.
  const serializedKey = unstable_serialize(key);
  const hasFailure = Boolean(
    (cache.get(serializedKey)?.data as InboxInsightsResult | undefined)
      ?.failure,
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const refreshInterval = useCallback(
    (latest?: InboxInsightsResult) => getPartialRetryMs(latest),
    [hasFailure],
  );

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
          const { emailAccountId } = request;
          const kept = new Map(
            request.items.flatMap((item) => {
              const entry = extractions.get(emailAccountId, item.messageId);
              return entry ? [[item.messageId, entry] as const] : [];
            }),
          );
          const known = [...kept.keys()].map(encodeURIComponent).join(",");
          const keptPeople = [...kept.values()].some(
            (entry) => entry.people.length,
          );
          const response = await accountFetcher([
            `/api/user/inbox-insights?items=${request.items.map((item) => item.pair).join(",")}${known ? `&known=${known}` : ""}${keptPeople ? "&events=1" : ""}`,
            emailAccountId,
          ]);
          return request.items.flatMap((item) => {
            const fresh = response.insights[item.threadId];
            if (fresh?.withAi && fresh.messageId === item.messageId)
              extractions.set(emailAccountId, item.messageId, fresh);
            const entry = fresh ?? kept.get(item.messageId);
            if (!entry) return [];
            return [
              [
                item.key,
                toThreadInsight({ entry, item, emailAccountId, response }),
              ] as const,
            ];
          });
        }),
      );
      const failures = settled.flatMap((outcome) =>
        outcome.status === "rejected" ? [outcome.reason] : [],
      );
      // Nothing to show: SWR keeps the previous rows and retries as usual.
      if (failures.length === settled.length) throw failures[0];
      const insights = Object.fromEntries(
        settled.flatMap((outcome) =>
          outcome.status === "fulfilled" ? outcome.value : [],
        ),
      );
      if (!failures.length) return { insights };
      const previous = cache.get(serializedKey)?.data as
        | InboxInsightsResult
        | undefined;
      const { status, retryAfterMs } = failures[0] as {
        status?: number;
        retryAfterMs?: number;
      };
      return {
        insights,
        failure: {
          status,
          retryAfterMs,
          attempt: (previous?.failure?.attempt ?? 0) + 1,
          // In the cache, so every reader of these rows waits the same and
          // their polls share one request.
          jitter: 0.75 + Math.random() / 2,
        },
      };
    },
    { revalidateOnFocus: false, keepPreviousData: true, refreshInterval },
  );

  return {
    data: result.data?.insights,
    error: result.error,
    isLoading: result.isLoading,
  };
}

type InboxInsightsResult = {
  insights: Record<string, ThreadInsightData>;
  /** Set when only some of the accounts answered. */
  failure?: {
    status?: number;
    retryAfterMs?: number;
    /** How many fetches in a row came back with an account missing. */
    attempt: number;
    jitter: number;
  };
};

function getPartialRetryMs(latest: InboxInsightsResult | undefined) {
  const failure = latest?.failure;
  if (!failure || failure.attempt > PARTIAL_RETRY_LIMIT) return 0;
  const hint = getRetryHint(failure, failure.attempt, failure.jitter);
  if (hint.kind === "stop") return 0;
  if (hint.kind === "wait") return hint.ms;
  return PARTIAL_RETRY_BASE_MS * 2 ** (failure.attempt - 1);
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
            messageId: item.messageId,
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

/** One row's insight: what the email asks, the meeting with its people, and the reply this browser kept. */
function toThreadInsight({
  entry,
  item,
  emailAccountId,
  response,
}: {
  entry: InboxInsightExtraction;
  item: { threadId: string; messageId: string };
  emailAccountId: string;
  response: GetInboxInsightsResponse;
}): ThreadInsightData {
  const suggestion = response.draftRepliesEnabled
    ? keptSuggestionFor({
        emailAccountId,
        threadId: item.threadId,
        messageId: item.messageId,
      })
    : null;
  let reply: ThreadInsightData["reply"] = null;
  if (suggestion?.status === "suggested") reply = "ready";
  else if (suggestion?.status === "insufficient") reply = "needs-info";
  return {
    insight: entry.insight,
    meeting: nextMeetingWith(entry.people, response.events),
    reply,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}
