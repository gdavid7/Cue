/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it } from "vitest";
import type { NewsletterStatsQuery } from "@/app/api/user/stats/newsletters/route";
import { useNewsletterStats } from "@/app/(app)/[emailAccountId]/bulk-unsubscribe/use-newsletter-stats";

(globalThis as { React?: typeof React }).React = React;

const baseParams: NewsletterStatsQuery = {
  types: [],
  filters: [],
  orderBy: "emails",
  orderDirection: "desc",
  limit: 50,
};

describe("useNewsletterStats", () => {
  afterEach(cleanup);

  it("asks for interactive priority on the page's first load and not on a refresh", async () => {
    const { requests, wrapper } = setup();
    const { result } = renderHook(
      () => useNewsletterStats(baseParams, { refreshInterval: 1_000_000 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    await waitFor(() => expect(result.current.isValidating).toBe(false));
    expect(requests).toHaveLength(1);
    expect(isInteractive(requests[0])).toBe(true);

    await act(async () => {
      await result.current.mutate();
    });

    expect(requests).toHaveLength(2);
    expect(isInteractive(requests[1])).toBe(false);
  });

  it("asks for interactive priority again when the person switches to another view", async () => {
    const { requests, wrapper } = setup();
    const { result, rerender } = renderHook(
      ({ params }) =>
        useNewsletterStats(params, { refreshInterval: 1_000_000 }),
      { wrapper, initialProps: { params: baseParams } },
    );
    await waitFor(() => expect(result.current.isValidating).toBe(false));
    await waitFor(() => expect(result.current.showSkeleton).toBe(false));

    rerender({ params: { ...baseParams, orderBy: "unread" } });

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(isInteractive(requests[1])).toBe(true);
    expect(new URL(requests[1], "http://x").searchParams.get("orderBy")).toBe(
      "unread",
    );
  });

  it("keeps a searched view at the route's full wait, never asking for interactive", async () => {
    const { requests, wrapper } = setup();
    const { result } = renderHook(
      () =>
        useNewsletterStats(
          { ...baseParams, search: "news@example.com" },
          { refreshInterval: 1_000_000 },
        ),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(requests).toHaveLength(1);
    expect(isInteractive(requests[0])).toBe(false);
  });

  it("sends later retries without the flag once a first load has failed", async () => {
    const { requests, wrapper } = setup({ failFirst: true });
    const { result } = renderHook(
      () => useNewsletterStats(baseParams, { refreshInterval: 1_000_000 }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.error).toBeDefined());
    await waitFor(() => expect(result.current.showSkeleton).toBe(false));
    expect(isInteractive(requests[0])).toBe(true);

    await act(async () => {
      await result.current.mutate();
    });

    expect(requests).toHaveLength(2);
    expect(isInteractive(requests[1])).toBe(false);
  });
});

function setup({ failFirst = false }: { failFirst?: boolean } = {}) {
  const requests: string[] = [];
  const fetcher = async (url: string) => {
    requests.push(url);
    if (failFirst && requests.length === 1) throw new Error("Server error");
    return {
      newsletters: [],
      filtersAvailable: true,
      nextCursor: null,
    };
  };
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher,
        dedupingInterval: 0,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
  return { requests, wrapper };
}

function isInteractive(url: string) {
  return new URL(url, "http://x").searchParams.get("interactive") === "true";
}
