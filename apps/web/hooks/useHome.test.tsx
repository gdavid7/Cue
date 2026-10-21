// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTodayChanged } from "@/utils/home/today-changes";
import {
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";
import { readCachedToday, writeCachedToday } from "@/utils/home/today-cache";
import { useHome, useWarmHome } from "./useHome";

// The zone useHome asks the server to count "today" in.
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

vi.mock("@/utils/swr", () => ({
  getAccountScopedKey: (path: string, emailAccountId: string) => [
    path,
    emailAccountId,
  ],
}));

describe("useHome", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks again for a pending lane twelve times, then gives up until retried", async () => {
    const fetcher = vi.fn(async () => answer(["alsoInInbox"]));
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(fetcher),
    });

    await act(() => vi.advanceTimersByTimeAsync(5000 * 20));

    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(result.current.gaveUp).toBe(true);

    await act(async () => {
      result.current.retry();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(fetcher).toHaveBeenCalledTimes(13);
    expect(result.current.gaveUp).toBe(false);
  });

  it("reloads when Cue changes what needs a reply, so new mail shows without a reload", async () => {
    const fetcher = vi.fn(async () => answer([]));
    renderHook(() => useHome("account"), { wrapper: wrapper(fetcher) });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // The first change shows at once.
    await act(async () => {
      announceTodayChanged();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // A backlog sorts a message every second or so; Today loads at most once
    // per ten seconds for them, and once more for the last.
    await act(async () => {
      for (let second = 0; second < 5; second++) {
        announceTodayChanged();
        await vi.advanceTimersByTimeAsync(1000);
      }
    });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(fetcher).toHaveBeenCalledTimes(3);

    await act(() => vi.advanceTimersByTimeAsync(30_000));
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("reloads when the user comes back to the tab", async () => {
    const fetcher = vi.fn(async () => answer([]));
    renderHook(() => useHome("account"), { wrapper: wrapper(fetcher) });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops asking once every lane has loaded", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(answer(["waiting"]))
      .mockResolvedValue(answer([]));
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(fetcher),
    });

    await act(() => vi.advanceTimersByTimeAsync(5000 * 5));

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.gaveUp).toBe(false);
  });
});

describe("useHome with a cached Today", () => {
  beforeEach(() => {
    // SWR refreshes data it already shows on the next animation frame.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"],
    });
    window.localStorage.clear();
    resetBrowserCacheForTesting("user");
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens on what Today last showed, then replaces it with one fresh load", async () => {
    writeCachedToday({
      emailAccountId: "account",
      timeZone: ZONE,
      data: todayData("cached"),
      now: Date.now(),
    });
    const loads = pendingLoads();
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(loads.fetcher),
    });

    expect(result.current.data).toEqual(todayData("cached"));
    expect(result.current.isLoading).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(loads.fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      loads.resolve(todayData("fresh"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.data).toEqual(todayData("fresh"));
    expect(loads.fetcher).toHaveBeenCalledTimes(1);
    expect(
      readCachedToday({
        emailAccountId: "account",
        timeZone: ZONE,
        now: Date.now(),
      }),
    ).toEqual(todayData("fresh"));
  });

  it("shows an action on a cached row, and the fresh load still lands", async () => {
    writeCachedToday({
      emailAccountId: "account",
      timeZone: ZONE,
      data: todayData("cached"),
      now: Date.now(),
    });
    const loads = pendingLoads();
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(loads.fetcher),
    });
    await act(() => vi.advanceTimersByTimeAsync(20));

    // Starring a row while the first load is on its way, as the rows do.
    await act(async () => {
      await result.current.mutate(
        (current) => current && starFirstRow(current),
        { revalidate: false },
      );
    });
    expect(result.current.data?.needsYou[0].starred).toBe(true);

    // SWR drops a load that a change overtook; another one replaces it.
    await act(async () => {
      loads.resolve(todayData("fresh"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(loads.fetcher).toHaveBeenCalledTimes(2);
    await act(async () => {
      loads.resolve(todayData("fresher"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(result.current.data).toEqual(todayData("fresher"));
  });

  it("settles on the newest load when a change arrives while one is on its way", async () => {
    const loads = pendingLoads();
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(loads.fetcher),
    });
    await act(() => vi.advanceTimersByTimeAsync(20));
    await act(async () => {
      announceTodayChanged();
      await vi.advanceTimersByTimeAsync(20);
    });
    for (let load = 0; load < 10; load++) {
      await act(async () => {
        loads.resolve(todayData(`load ${load}`));
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    expect(loads.fetcher.mock.calls.length).toBeLessThanOrEqual(3);
    expect(result.current.data).toEqual(todayData("load 1"));
  });

  it("keeps the cached rows of a lane Gmail is slow to serve, and asks again", async () => {
    writeCachedToday({
      emailAccountId: "account",
      timeZone: ZONE,
      data: todayData("cached"),
      now: Date.now(),
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
        ...todayData("ignored"),
        needsYou: [],
        pending: ["needsYou"],
        stats: { needsYou: 0 },
      })
      .mockResolvedValue(todayData("fresh"));
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(fetcher),
    });

    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(fetcher).toHaveBeenCalledTimes(1);
    // No placeholders over rows already on screen.
    expect(result.current.data?.pending).toEqual([]);
    expect(result.current.data?.needsYou[0].subject).toBe("cached");
    expect(result.current.data?.stats.needsYou).toBe(1);

    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data).toEqual(todayData("fresh"));
  });

  it("shows another user's Today to nobody", () => {
    writeCachedToday({
      emailAccountId: "account",
      timeZone: ZONE,
      data: todayData("theirs"),
      now: Date.now(),
    });
    setBrowserCacheUser("someone-else");
    const { result } = renderHook(() => useHome("account"), {
      wrapper: wrapper(() => new Promise(() => {})),
    });
    expect(result.current.data).toBeUndefined();
    expect(result.current.isLoading).toBe(true);
  });
});

describe("useWarmHome", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "Date", "requestAnimationFrame"],
    });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads nothing until Today is wanted, then opens Today on that one load", async () => {
    const loads = pendingLoads();
    const { result, rerender } = renderHook(
      ({ wanted, open }: { wanted: boolean; open: boolean }) => {
        useWarmHome("account", wanted);
        return useHome(open ? "account" : null);
      },
      {
        initialProps: { wanted: false, open: false },
        wrapper: wrapper(loads.fetcher, 2000),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(loads.fetcher).not.toHaveBeenCalled();

    rerender({ wanted: true, open: false });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(loads.fetcher).toHaveBeenCalledTimes(1);

    // Today opens while the load is still on its way, and shares it.
    rerender({ wanted: true, open: true });
    await act(async () => {
      loads.resolve(answer([]));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(loads.fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(answer([]));
  });

  it("opens on the saved copy after a hover, with one load", async () => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user");
    writeCachedToday({
      emailAccountId: "account",
      timeZone: ZONE,
      data: todayData("cached"),
      now: Date.now(),
    });
    const loads = pendingLoads();
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        useWarmHome("account", true);
        return useHome(open ? "account" : null);
      },
      { initialProps: { open: false }, wrapper: wrapper(loads.fetcher, 2000) },
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));

    rerender({ open: true });
    expect(result.current.data).toEqual(todayData("cached"));
    await act(() => vi.advanceTimersByTimeAsync(100));
    await act(async () => {
      loads.resolve(todayData("fresh"));
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(loads.fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(todayData("fresh"));
  });

  it("refreshes a hover's load that something changed before Today opened", async () => {
    const fetcher = vi.fn(async () => answer([]));
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        useWarmHome("account", true);
        return useHome(open ? "account" : null);
      },
      { initialProps: { open: false }, wrapper: wrapper(fetcher, 2000) },
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Such as the user's reply, before anything on screen listens for it.
    announceTodayChanged();
    rerender({ open: true });
    expect(result.current.data).toEqual(answer([]));
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// Only the lanes; the rest of Today's answer plays no part here.
function todayData(subject: string) {
  return {
    needsYou: [
      {
        threadId: "thread",
        fromName: "Alice",
        fromEmail: "alice@example.com",
        subject,
        preview: "Hello",
        at: "2026-10-16T10:00:00Z",
        priority: "medium",
        unread: true,
        messageId: "message",
        starred: false,
        inInbox: true,
      },
    ],
    waiting: [],
    alsoInInbox: [],
    reading: [],
    pending: [],
    failed: [],
    agentTasks: [],
    cue: { aiAccess: true, replyTracking: true, hasReadMail: true },
    today: { checked: 0, filed: 0, filedLabel: null },
    calendar: { connected: true, next: null },
    nextUp: [],
    stats: { needsYou: 1, estimatedMinutes: 3, needsYouCapped: false },
  } as unknown as GetHomeResponse;
}

/** A whole answer, with these lanes still pending. */
function answer(pending: string[] = []) {
  return { ...todayData("answer"), pending } as unknown as GetHomeResponse;
}

function starFirstRow(data: GetHomeResponse): GetHomeResponse {
  return {
    ...data,
    needsYou: data.needsYou.map((row, index) =>
      index === 0 ? { ...row, starred: true } : row,
    ),
  };
}

/** A fetcher whose loads each wait for the next `resolve`. */
function pendingLoads() {
  const waiting: ((value: unknown) => void)[] = [];
  return {
    fetcher: vi.fn(
      () =>
        new Promise((resolveLoad) => {
          waiting.push(resolveLoad);
        }),
    ),
    resolve: (value: unknown) => waiting.shift()?.(value),
  };
}

function wrapper(fetcher: () => Promise<unknown>, dedupingInterval = 0) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ fetcher, provider: () => new Map(), dedupingInterval }}>
      {children}
    </SWRConfig>
  );
}
