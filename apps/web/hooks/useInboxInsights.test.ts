// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import {
  keptSuggestions,
  suggestionKey,
} from "@/utils/thread-context/suggested-reply-store";
import {
  getInboxInsightRequests,
  refreshInboxInsights,
  resetInboxInsightRequestsForTesting,
  threadInsightItem,
  useInboxInsights,
} from "./useInboxInsights";

const mail = vi.hoisted(() => ({
  settled: true,
  waiting: [] as (() => void)[],
  settle() {
    mail.settled = true;
    for (const callback of mail.waiting.splice(0)) callback();
  },
}));

vi.mock("@/providers/EmailAccountProvider", () => ({ useAccount: vi.fn() }));
vi.mock("@/utils/mail-engine/first-mail-list", () => ({
  afterMailCaughtUp: (callback: () => void) => {
    if (mail.settled) callback();
    else mail.waiting.push(callback);
    return () => undefined;
  },
}));

const INSIGHT = {
  action: "reply",
  task: "Confirm the time",
  date: null,
  dateRole: null,
  fact: null,
  factLabel: null,
};
const SHOWN = { insight: INSIGHT, meeting: null, reply: null };

beforeEach(() => {
  window.localStorage.clear();
  resetBrowserCacheForTesting();
  resetInboxInsightRequestsForTesting();
  mail.settled = true;
  mail.waiting = [];
});

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
    const fetcher = vi.fn(async () => fromServer({ t1: extraction("t1") }));
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
      expect(result.current.data).toEqual({ "work:t1": SHOWN }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the insights already shown when a new page is rate limited", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async ([url]: [string, string]) => {
      if (url.includes("t2")) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      return fromServer({ t1: extraction("t1") });
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
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await waitFor(() => expect(result.current.error).toBeDefined());

    expect(result.current.error).toMatchObject({ status: 429 });
    expect(result.current.data).toEqual(shown);
    vi.useRealTimers();
  });

  // The storm behind a 45 s inbox (RL-1): each page a catch-up commits changed
  // the rows, and each change was a request of its own.
  it("asks once more, not once per change, while sync keeps changing the rows", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const fetcher = vi.fn(async ([url]: [string, string]) =>
      fromServer(
        Object.fromEntries(
          [...url.matchAll(/(t\d+):/g)].map(([, threadId]) => [
            threadId,
            extraction(threadId),
          ]),
        ),
      ),
    );
    const rows = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        item({ emailAccountId: "work", threadId: `t${index}` }),
      );
    const { result, rerender } = renderHook(
      ({ items }) => useInboxInsights(items),
      { wrapper: wrapperFor(fetcher), initialProps: { items: rows(2) } },
    );
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    for (let page = 3; page <= 8; page++) {
      rerender({ items: rows(page) });
      await act(() => vi.advanceTimersByTimeAsync(2000));
    }
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    await waitFor(() =>
      expect(Object.keys(result.current.data ?? {})).toHaveLength(8),
    );
    vi.useRealTimers();
  });

  it("waits for the mail list to catch up before asking about rows, but not for the open conversation", async () => {
    mail.settled = false;
    const fetcher = vi.fn(async ([url]: [string, string]) =>
      fromServer(
        url.includes("t9")
          ? { t9: extraction("t9") }
          : { t1: extraction("t1") },
      ),
    );
    renderHook(
      () => [
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
        useInboxInsights([
          threadInsightItem({
            emailAccountId: "work",
            threadId: "t9",
            messageId: "t9-latest",
          }),
        ]),
      ],
      { wrapper: wrapperFor(fetcher) },
    );

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]?.[0][0]).toContain("items=t9:t9-latest");
    expect(fetcher.mock.calls[0]?.[0][0]).toContain("open=1");

    act(() => mail.settle());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]?.[0][0]).toContain("items=t1:t1-latest");
    expect(fetcher.mock.calls[1]?.[0][0]).not.toContain("open=1");
  });
});

// RL-1 review M3: the browser's store can refuse a write; an answer it
// dropped must not be asked for again and again.
describe("useInboxInsights when this browser can't keep what it read", () => {
  beforeEach(() => {
    // No signed-in user yet: the browser's store keeps nothing.
    resetBrowserCacheForTesting(null);
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks once for the rows and shows the answer from this page", async () => {
    const fetcher = vi.fn(async () => fromServer({ t1: extraction("t1") }));
    const { result } = renderHook(
      () =>
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
      { wrapper: wrapperFor(fetcher) },
    );

    await waitFor(() =>
      expect(result.current.data).toEqual({ "work:t1": SHOWN }),
    );
    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("asks a bounded number of times for the open conversation the server keeps leaving out", async () => {
    const fetcher = vi.fn(async () => fromServer({}));
    renderHook(
      () =>
        useInboxInsights([
          threadInsightItem({
            emailAccountId: "work",
            threadId: "t9",
            messageId: "t9-latest",
          }),
        ]),
      { wrapper: wrapperFor(fetcher) },
    );

    await act(() => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(fetcher.mock.calls.length).toBeGreaterThan(0);
    expect(fetcher.mock.calls.length).toBeLessThanOrEqual(6);
  });
});

// RD-3: the server keeps none of this, so the browser does.
describe("useInboxInsights and what this browser keeps", () => {
  it("never asks again on this page, and names what it kept on the next", async () => {
    const fetcher = vi.fn(async ([url]: [string, string]) =>
      url.includes("known=")
        ? fromServer({})
        : fromServer({ t1: extraction("t1") }),
    );
    const items = [item({ emailAccountId: "work", threadId: "t1" })];

    const first = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(fetcher),
    });
    await waitFor(() =>
      expect(first.result.current.data).toEqual({ "work:t1": SHOWN }),
    );
    first.unmount();
    const again = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(fetcher),
    });
    expect(again.result.current.data).toEqual({ "work:t1": SHOWN });
    expect(fetcher).toHaveBeenCalledTimes(1);
    again.unmount();

    // The next page load.
    resetInboxInsightRequestsForTesting();
    const second = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(fetcher),
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(second.result.current.data).toEqual({ "work:t1": SHOWN });
    expect(fetcher.mock.calls.at(-1)?.[0][0]).toContain("known=t1-latest");
  });

  // Without AI access there is no insight, only who is on the email. Not
  // keeping that made every render read each message from the provider again.
  it("keeps an email read without AI for a day, then asks again", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const fetcher = vi.fn(async ([url]: [string, string]) =>
        url.includes("known=")
          ? fromServer({})
          : fromServer({
              t1: { ...extraction("t1"), insight: null, withAi: false },
            }),
      );
      const items = [item({ emailAccountId: "work", threadId: "t1" })];

      const first = renderHook(() => useInboxInsights(items), {
        wrapper: wrapperFor(fetcher),
      });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      first.unmount();
      resetInboxInsightRequestsForTesting();

      const second = renderHook(() => useInboxInsights(items), {
        wrapper: wrapperFor(fetcher),
      });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
      expect(fetcher.mock.calls[1]?.[0][0]).toContain("known=t1-latest");
      second.unmount();
      resetInboxInsightRequestsForTesting();

      vi.advanceTimersByTime(25 * 60 * 60 * 1000);
      renderHook(() => useInboxInsights(items), {
        wrapper: wrapperFor(fetcher),
      });
      await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
      expect(fetcher.mock.calls[2]?.[0][0]).not.toContain("known=");
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches the meeting with someone on the email in this browser", async () => {
    const fetcher = vi.fn(async () => ({
      ...fromServer({
        t1: {
          ...extraction("t1"),
          people: [{ email: "sarah@acme.com", name: "Sarah Chen" }],
        },
      }),
      events: [
        {
          title: "Renewal call",
          at: "2026-10-20T17:00:00.000Z",
          attendees: ["sarah@acme.com"],
        },
      ],
    }));

    const { result } = renderHook(
      () =>
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
      { wrapper: wrapperFor(fetcher) },
    );

    await waitFor(() =>
      expect(result.current.data?.["work:t1"]?.meeting).toMatchObject({
        title: "Renewal call",
        with: "Sarah Chen",
      }),
    );
  });

  it("says a draft is ready from the reply this browser kept", async () => {
    keptSuggestions.set(
      "work",
      suggestionKey({ threadId: "t1", messageId: "t1-latest", web: false }),
      {
        suggestion: { status: "suggested", reply: "Yes.", citations: [] },
        canSearchWeb: false,
      },
    );
    const fetcher = vi.fn(async () => fromServer({ t1: extraction("t1") }));

    const { result } = renderHook(
      () =>
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
      { wrapper: wrapperFor(fetcher) },
    );

    await waitFor(() =>
      expect(result.current.data?.["work:t1"]?.reply).toBe("ready"),
    );
  });

  it("says Cue drafted a reply it wrote ahead of time, even before it read the email", async () => {
    const fetcher = vi.fn(async () => fromServer({}, ["t1-latest"]));

    const { result } = renderHook(
      () =>
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
      { wrapper: wrapperFor(fetcher) },
    );

    await waitFor(() =>
      expect(result.current.data?.["work:t1"]).toEqual({
        insight: null,
        meeting: null,
        reply: "drafted",
      }),
    );
  });
});

// DR-3 through RL-1's queue: dismissing Cue's reply takes the row's label
// away at once and reads the rows again once, without reading the emails.
describe("refreshInboxInsights", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops a dismissed draft at once and asks again once, on the rows' spacing", async () => {
    let draftedNow = ["t1-latest"];
    const fetcher = vi.fn(async () =>
      fromServer({ t1: extraction("t1") }, draftedNow),
    );
    const { result } = renderHook(
      () =>
        useInboxInsights([item({ emailAccountId: "work", threadId: "t1" })]),
      { wrapper: wrapperFor(fetcher) },
    );
    await waitFor(() =>
      expect(result.current.data?.["work:t1"]?.reply).toBe("drafted"),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    draftedNow = [];
    act(() => {
      refreshInboxInsights("work", { withoutDraftFor: "t1-latest" });
      refreshInboxInsights("work");
    });
    expect(result.current.data?.["work:t1"]?.reply).toBeNull();

    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    // The email was already read: only the drafts and settings are asked for.
    expect(fetcher.mock.calls[1]?.[0][0]).toContain("known=t1-latest");
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("useInboxInsights with one account busy in All inboxes", () => {
  const BOTH = { "work:t1": SHOWN, "personal:t1": SHOWN };
  const WORK_ONLY = { "work:t1": SHOWN };
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

    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(busy.personalRequests()).toBe(2);
    expect(result.current.data).toEqual(WORK_ONLY);

    await act(() => vi.advanceTimersByTimeAsync(16_000));
    expect(busy.personalRequests()).toBe(3);
    expect(result.current.data).toEqual(BOTH);
  });

  it("stops asking for an account that keeps failing after five more tries", async () => {
    const busy = personalBusy(Number.POSITIVE_INFINITY, { status: 500 });
    const { result } = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(busy.fetcher),
    });
    await waitFor(() => expect(result.current.data).toEqual(WORK_ONLY));

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(busy.personalRequests()).toBe(6);
    expect(result.current.data).toEqual(WORK_ONLY);
  });

  it("keeps a deferred account's rows queued past the usual tries, waiting longer each time", async () => {
    const busy = personalBusy(Number.POSITIVE_INFINITY, {
      status: 503,
      retryAfterMs: 1000,
    });
    const { result } = renderHook(() => useInboxInsights(items), {
      wrapper: wrapperFor(busy.fetcher),
    });
    await waitFor(() => expect(result.current.data).toEqual(WORK_ONLY));

    // Not before the rows' 15 s spacing, though Retry-After said 1 s.
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(busy.personalRequests()).toBe(1);
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(busy.personalRequests()).toBeGreaterThan(6);
    // Never more often than the spacing: at most 40 in 10 minutes.
    expect(busy.personalRequests()).toBeLessThanOrEqual(41);
    expect(result.current.isLoading).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it("shows no error while every account is deferred, and fills in once the budget is back", async () => {
    const one = [item({ emailAccountId: "personal", threadId: "t1" })];
    const busy = personalBusy(8, { status: 503, retryAfterMs: 20_000 });
    const { result } = renderHook(() => useInboxInsights(one), {
      wrapper: wrapperFor(busy.fetcher),
    });
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(busy.personalRequests()).toBe(1);
    expect(result.current.error).toBeUndefined();

    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(busy.personalRequests()).toBe(9);
    expect(result.current.data).toEqual({ "personal:t1": SHOWN });
    expect(result.current.error).toBeUndefined();
  });

  it("asks once per retry however many readers share the rows", async () => {
    const busy = personalBusy(1, { status: 503, retryAfterMs: 1000 });
    const { result } = renderHook(
      () => [useInboxInsights(items), useInboxInsights(items)] as const,
      { wrapper: wrapperFor(busy.fetcher) },
    );
    await waitFor(() => expect(result.current[0].data).toEqual(WORK_ONLY));
    expect(busy.personalRequests()).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(16_000));
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
      return fromServer({ t1: extraction("t1") });
    });
    return { fetcher, personalRequests: () => personal };
  }
});

// PF-4: a page was asked about in thread-id order, which for Gmail's
// time-ordered ids put the newest rows, the ones on screen, in the last
// request, a spacing and two requests after the first.
describe("useInboxInsights and the rows on screen", () => {
  it("asks about the page in screen order, the rows on top first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetcher, asked } = answeringFetcher();
    const rows = newestFirst(50);
    renderHook(() => useInboxInsights(rows), {
      wrapper: wrapperFor(fetcher),
    });

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(asked(0)).toEqual(threadIdsOf(rows.slice(0, 25)));

    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(asked(1)).toEqual(threadIdsOf(rows.slice(25)));
    vi.useRealTimers();
  });

  it("asks for the rows on screen and the next screenful on their own, in no more requests", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mail.settled = false;
    const { fetcher, asked } = answeringFetcher();
    const rows = newestFirst(30);
    const { result } = renderHook(() => useInboxInsights(rows), {
      wrapper: wrapperFor(fetcher),
    });
    act(() => result.current.setVisibleRows({ start: 0, end: 8 }));
    act(() => mail.settle());

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(asked(0)).toEqual(threadIdsOf(rows.slice(0, 16)));

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    // Pages of 25 asked twice for 30 rows; so does this.
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(asked(1)).toEqual(threadIdsOf(rows.slice(16)));
    vi.useRealTimers();
  });

  it("asks next about the rows the reader scrolled to, then the rest nearest first", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mail.settled = false;
    const { fetcher, asked } = answeringFetcher();
    const rows = newestFirst(80);
    const { result } = renderHook(() => useInboxInsights(rows), {
      wrapper: wrapperFor(fetcher),
    });
    act(() => result.current.setVisibleRows({ start: 0, end: 8 }));
    act(() => mail.settle());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(asked(0)).toEqual(threadIdsOf(rows.slice(0, 16)));

    act(() => result.current.setVisibleRows({ start: 60, end: 68 }));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(asked(1)).toEqual(threadIdsOf(rows.slice(60, 76)));

    await act(() => vi.advanceTimersByTimeAsync(60_000));
    // Pages of 25 asked four times for 80 rows; so does this.
    expect(fetcher).toHaveBeenCalledTimes(4);
    // The rows either side of where the reader is, before those far above.
    expect(asked(2).sort()).toEqual(
      threadIdsOf([...rows.slice(39, 60), ...rows.slice(76)]).sort(),
    );
    expect(Object.keys(result.current.data ?? {})).toHaveLength(80);
    vi.useRealTimers();
  });

  it("places rows by their row on screen when a row has nothing to ask about", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mail.settled = false;
    const { fetcher, asked } = answeringFetcher();
    // Thread 3 is a draft only: it is a row on screen but asks about nothing.
    const rows = newestFirst(31)
      .map((row, index) => ({ ...row, index }))
      .filter((row) => row.index !== 3);
    const { result } = renderHook(() => useInboxInsights(rows), {
      wrapper: wrapperFor(fetcher),
    });
    act(() => result.current.setVisibleRows({ start: 0, end: 4 }));
    act(() => mail.settle());

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(asked(0)).toEqual(threadIdsOf(rows.filter((row) => row.index < 8)));
    vi.useRealTimers();
  });

  it("forgets the rows on screen when the list is replaced", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mail.settled = false;
    const { fetcher, asked } = answeringFetcher();
    const inbox = newestFirst(40);
    const archive = newestFirst(40).map((row) => ({
      ...row,
      key: `archive:${row.threadId}`,
      threadId: `a${row.threadId}`,
      messageId: `a${row.messageId}`,
    }));
    const { result, rerender } = renderHook(
      ({ items }) => useInboxInsights(items),
      { wrapper: wrapperFor(fetcher), initialProps: { items: inbox } },
    );
    act(() => result.current.setVisibleRows({ start: 20, end: 24 }));
    rerender({ items: archive });
    act(() => mail.settle());

    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(asked(0)).toEqual(threadIdsOf(archive.slice(0, 25)));
    vi.useRealTimers();
  });

  it("asks nothing more when the same rows are reordered", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetcher } = answeringFetcher();
    const rows = newestFirst(30);
    const { rerender } = renderHook(({ items }) => useInboxInsights(items), {
      wrapper: wrapperFor(fetcher),
      initialProps: { items: rows },
    });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));

    rerender({ items: [...rows].reverse() });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    rerender({ items: rows });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  function answeringFetcher() {
    const fetcher = vi.fn(async ([url]: [string, string]) =>
      fromServer(
        Object.fromEntries(
          threadIdsIn(url).map((threadId) => [threadId, extraction(threadId)]),
        ),
      ),
    );
    return {
      fetcher,
      asked: (call: number) => threadIdsIn(fetcher.mock.calls[call]?.[0][0]),
    };
  }

  function threadIdsIn(url: string | undefined) {
    const items = new URL(url ?? "", "https://cue.test").searchParams.get(
      "items",
    );
    return (items ?? "")
      .split(",")
      .map((pair) => decodeURIComponent(pair.split(":")[0]));
  }

  // Gmail's thread ids grow with time and the list shows the newest first.
  function newestFirst(count: number) {
    return Array.from({ length: count }, (_, index) =>
      item({
        emailAccountId: "work",
        threadId: `t${String(count - index).padStart(3, "0")}`,
      }),
    );
  }

  function threadIdsOf(rows: { threadId: string }[]) {
    return rows.map((row) => row.threadId);
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

function extraction(threadId: string) {
  return {
    messageId: `${threadId}-latest`,
    insight: INSIGHT,
    people: [],
    withAi: true,
  };
}

function fromServer(
  insights: Record<
    string,
    Omit<ReturnType<typeof extraction>, "insight" | "withAi"> & {
      insight: typeof INSIGHT | null;
      withAi: boolean;
    }
  >,
  draftedMessageIds: string[] = [],
) {
  return { insights, events: [], draftRepliesEnabled: true, draftedMessageIds };
}
