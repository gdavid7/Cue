// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getInboxInsightRequests, useInboxInsights } from "./useInboxInsights";

vi.mock("@/providers/EmailAccountProvider", () => ({ useAccount: vi.fn() }));

describe("getInboxInsightRequests", () => {
  it("asks each account about its own rows, even when thread ids collide", () => {
    const requests = getInboxInsightRequests([
      item({ emailAccountId: "work", threadId: "t1" }),
      item({ emailAccountId: "personal", threadId: "t1" }),
      item({ emailAccountId: "work", threadId: "t2" }),
    ]);

    expect(
      requests.map((request) => ({
        emailAccountId: request.emailAccountId,
        keys: request.items.map((requestItem) => requestItem.key),
      })),
    ).toEqual([
      { emailAccountId: "personal", keys: ["personal:t1"] },
      { emailAccountId: "work", keys: ["work:t1", "work:t2"] },
    ]);
  });

  it("drops repeated rows and splits an account's rows into pages of 50", () => {
    const items = Array.from({ length: 51 }, (_, index) =>
      item({ emailAccountId: "work", threadId: `t${index}` }),
    );
    const requests = getInboxInsightRequests([...items, items[0]]);

    expect(requests.map((request) => request.items.length)).toEqual([50, 1]);
  });
});

describe("useInboxInsights", () => {
  it("asks for nothing while paused, then asks once for the rows on screen", async () => {
    const fetcher = vi.fn(async () => ({
      insights: { t1: { insight: null, meeting: null, reply: "ready" } },
    }));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        { value: { fetcher, provider: () => new Map() } },
        children,
      );
    const items = [item({ emailAccountId: "work", threadId: "t1" })];

    const { result, rerender } = renderHook(
      ({ enabled }) => useInboxInsights(items, { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );
    rerender({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        "work:t1": { insight: null, meeting: null, reply: "ready" },
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the insights already shown when a new page is rate limited", async () => {
    const fetcher = vi.fn(async ([url]: [string, string]) => {
      if (url.includes("t2")) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      return {
        insights: { t1: { insight: null, meeting: null, reply: "ready" } },
      };
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        {
          value: {
            fetcher,
            provider: () => new Map(),
            shouldRetryOnError: false,
          },
        },
        children,
      );

    const { result, rerender } = renderHook(
      ({ items }) => useInboxInsights(items),
      {
        wrapper,
        initialProps: {
          items: [item({ emailAccountId: "work", threadId: "t1" })],
        },
      },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    const shown = result.current.data;

    rerender({
      items: [
        item({ emailAccountId: "work", threadId: "t1" }),
        item({ emailAccountId: "work", threadId: "t2" }),
      ],
    });
    await waitFor(() => expect(result.current.error).toBeDefined());

    expect(result.current.error).toMatchObject({ status: 429 });
    expect(result.current.data).toEqual(shown);
  });
});

describe("useInboxInsights with one account busy in All inboxes", () => {
  const READY = { insight: null, meeting: null, reply: "ready" };
  const BOTH = { "work:t1": READY, "personal:t1": READY };
  const WORK_ONLY = { "work:t1": READY };
  const items = [
    item({ emailAccountId: "work", threadId: "t1" }),
    item({ emailAccountId: "personal", threadId: "t1" }),
  ];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the other accounts' insights through two deferrals in a row, then fills it in", async () => {
    const busy = personalBusy(2, { status: 503, retryAfterMs: 1000 });
    const { result } = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(busy.fetcher),
    });

    await waitFor(() => expect(result.current.data).toEqual(WORK_ONLY));
    expect(result.current.error).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(busy.personalRequests()).toBe(2);
    expect(result.current.data).toEqual(WORK_ONLY);

    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(busy.personalRequests()).toBe(3);
    expect(result.current.data).toEqual(BOTH);
  });

  it("stops asking for an account that keeps failing after five more tries", async () => {
    const busy = personalBusy(Number.POSITIVE_INFINITY, {
      status: 503,
      retryAfterMs: 1000,
    });
    const { result } = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(busy.fetcher),
    });
    await waitFor(() => expect(result.current.data).toEqual(WORK_ONLY));

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(busy.personalRequests()).toBe(6);
    expect(result.current.data).toEqual(WORK_ONLY);
  });

  it("asks once per retry however many readers share the rows", async () => {
    const busy = personalBusy(1, { status: 503, retryAfterMs: 1000 });
    const { result } = renderHook(
      () => [useInboxInsights(items), useInboxInsights(items)] as const,
      { wrapper: wrapperFor(busy.fetcher) },
    );
    await waitFor(() => expect(result.current[0].data).toEqual(WORK_ONLY));
    expect(busy.personalRequests()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(busy.personalRequests()).toBe(2);
    expect(result.current[0].data).toEqual(BOTH);
    expect(result.current[1].data).toEqual(BOTH);
  });

  it("retries a rate-limited account once, after the limit's window", async () => {
    const busy = personalBusy(Number.POSITIVE_INFINITY, { status: 429 });
    const { result } = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(busy.fetcher),
    });
    await waitFor(() => expect(result.current.data).toEqual(WORK_ONLY));

    await act(() => vi.advanceTimersByTimeAsync(59_000));
    expect(busy.personalRequests()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(busy.personalRequests()).toBe(2);

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(busy.personalRequests()).toBe(2);
    expect(result.current.data).toEqual(WORK_ONLY);
  });

  function personalBusy(
    times: number,
    error: { status: number; retryAfterMs?: number },
  ) {
    let failuresLeft = times;
    let personal = 0;
    const fetcher = vi.fn(async ([, emailAccountId]: [string, string]) => {
      if (emailAccountId === "personal") {
        personal += 1;
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error("Gmail is busy"), error);
        }
      }
      return { insights: { t1: READY } };
    });
    return { fetcher, personalRequests: () => personal };
  }
});

function wrapperFor(fetcher: (key: [string, string]) => Promise<unknown>) {
  const cache = new Map();
  return ({ children }: { children: ReactNode }) =>
    createElement(
      SWRConfig,
      {
        value: {
          fetcher,
          provider: () => cache,
          shouldRetryOnError: false,
          dedupingInterval: 100,
        },
      },
      children,
    );
}

function item({
  emailAccountId,
  threadId,
}: {
  emailAccountId: string;
  threadId: string;
}) {
  return {
    key: `${emailAccountId}:${threadId}`,
    emailAccountId,
    threadId,
    messageId: `${threadId}-latest`,
  };
}
