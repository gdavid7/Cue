import { useEffect, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import type {
  NewsletterStatsQuery,
  NewsletterStatsResponse,
} from "@/app/api/user/stats/newsletters/route";
import { createSearchParams } from "@/utils/url";

/**
 * The Bulk unsubscribe list for `params`. The first read of a view (the page
 * opening, or a new sort, filter or range) is one a person waits on, so it
 * asks the server for interactive Gmail priority (D-086). Refreshes of a view
 * already on screen, from polling, focus, `mutate()` or a retry after the
 * first read failed, stay at the route's background priority so they never go
 * ahead of sync. A searched view waits for the filters in full, so it never
 * asks: the reader's one-sender lookup is the only interactive search.
 */
export function useNewsletterStats(
  params: NewsletterStatsQuery,
  { refreshInterval }: { refreshInterval: number },
) {
  const { fetcher } = useSWRConfig();
  const paramsString = createSearchParams(params).toString();
  const [loadedParams, setLoadedParams] = useState("");
  const isNewView = loadedParams !== paramsString;
  const asksInteractive = isNewView && !params.search;

  const { data, isLoading, isValidating, error, mutate } = useSWR<
    NewsletterStatsResponse,
    { error: string }
  >(
    `/api/user/stats/newsletters?${paramsString}`,
    (url: string) => {
      if (!fetcher) throw new Error("SWR fetcher is not configured");
      return fetcher(
        asksInteractive ? `${url}&interactive=true` : url,
      ) as Promise<NewsletterStatsResponse>;
    },
    { refreshInterval, keepPreviousData: true },
  );

  useEffect(() => {
    if (!isValidating && (data || error)) setLoadedParams(paramsString);
  }, [isValidating, data, error, paramsString]);

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
