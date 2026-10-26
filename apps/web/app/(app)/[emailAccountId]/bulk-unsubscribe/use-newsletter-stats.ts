import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type {
  NewsletterStatsQuery,
  NewsletterStatsResponse,
} from "@/app/api/user/stats/newsletters/route";
import { createSearchParams } from "@/utils/url";

/**
 * The Bulk unsubscribe list for `params`. The first read of a view (the page
 * opening, or a new sort, filter, search or range) is one a person waits on,
 * so it asks the server for interactive Gmail priority (D-086). Refreshes of
 * a view already on screen, from polling, focus or `mutate()`, stay at the
 * route's background priority so they never go ahead of sync.
 */
export function useNewsletterStats(
  params: NewsletterStatsQuery,
  { refreshInterval }: { refreshInterval: number },
) {
  const { fetcher } = useSWRConfig();
  const paramsString = createSearchParams(params).toString();
  const [loadedParams, setLoadedParams] = useState("");
  const isNewView = loadedParams !== paramsString;

  const { data, isLoading, isValidating, error, mutate } = useSWR<
    NewsletterStatsResponse,
    { error: string }
  >(
    `/api/user/stats/newsletters?${paramsString}`,
    (url: string) =>
      fetcher?.(
        isNewView
          ? `/api/user/stats/newsletters?${createSearchParams({ ...params, interactive: true })}`
          : url,
      ) as Promise<NewsletterStatsResponse>,
    { refreshInterval, keepPreviousData: true },
  );

  useEffect(() => {
    if (!isValidating && data) setLoadedParams(paramsString);
  }, [isValidating, data, paramsString]);

  return {
    data,
    isLoading,
    isValidating,
    error,
    mutate,
    // Validating a different view, not refreshing the one on screen.
    showSkeleton: isValidating && isNewView,
  };
}
