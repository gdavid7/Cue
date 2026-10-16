// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTodayChanged } from "@/utils/home/today-changes";
import {
  readCachedToday,
  resetCachedTodayBlocksForTesting,
  writeCachedToday,
} from "@/utils/home/today-cache";
import { resetWarmedHomesForTesting, useHome, useWarmHome } from "./useHome";

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
    const fetcher = vi.fn(async () => ({ pending: ["alsoInInbox"] }));
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
    const fetcher = vi.fn(async () => ({ pending: [] }));
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
    const fetcher = vi.fn(async () => ({ pending: [] }));
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
      .mockResolvedValueOnce({ pending: ["waiting"] })
      .mockResolvedValue({ pending: [] });
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
    resetCachedTodayBlocksForTesting();
    resetWarmedHomesForTesting();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("opens on what Today last showed, then replaces it with a fresh load", async () => {
    writeCachedToday({
      userId: "user",
      emailAccountId: "account",
      data: todayData("cached"),
      now: Date.now(),
    });
    let resolve: (value: unknown) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise((resolveLoad) => {
          resolve = resolveLoad;
        }),
    );
    const { result } = renderHook(() => useHome("account", "user"), {
      wrapper: wrapper(fetcher),
    });

    expect(result.current.data).toEqual(todayData("cached"));
    expect(result.current.isLoading).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(20));
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve(todayData("fresh"));
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.data).toEqual(todayData("fresh"));
    expect(
      readCachedToday({
        userId: "user",
        emailAccountId: "account",
        now: Date.now(),
      }),
    ).toEqual(todayData("fresh"));
  });

  it("shows another user's Today to nobody", () => {
    writeCachedToday({
      userId: "someone-else",
      emailAccountId: "account",
      data: todayData("theirs"),
      now: Date.now(),
    });
    const { result } = renderHook(() => useHome("account", "user"), {
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
    resetWarmedHomesForTesting();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("loads nothing until Today is wanted, then opens Today on that one load", async () => {
    let resolve: (value: unknown) => void = () => {};
    const fetcher = vi.fn(
      () =>
        new Promise((resolveLoad) => {
          resolve = resolveLoad;
        }),
    );
    const { result, rerender } = renderHook(
      ({ wanted, open }: { wanted: boolean; open: boolean }) => {
        useWarmHome("account", wanted);
        return useHome(open ? "account" : null);
      },
      {
        initialProps: { wanted: false, open: false },
        wrapper: wrapper(fetcher, 2000),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ wanted: true, open: false });
    await act(() => vi.advanceTimersByTimeAsync(100));
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Today opens while the load is still on its way, and shares it.
    rerender({ wanted: true, open: true });
    await act(async () => {
      resolve({ pending: [] });
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ pending: [] });
  });

  it("opens Today on the hover's load seconds later, without loading again", async () => {
    const fetcher = vi.fn(async () => ({ pending: [] }));
    const { result, rerender } = renderHook(
      ({ wanted, open }: { wanted: boolean; open: boolean }) => {
        useWarmHome("account", wanted);
        return useHome(open ? "account" : null);
      },
      {
        initialProps: { wanted: true, open: false },
        wrapper: wrapper(fetcher, 2000),
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(fetcher).toHaveBeenCalledTimes(1);

    rerender({ wanted: true, open: true });
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual({ pending: [] });
  });

  it("still asks again for a lane the hover's load found pending", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ pending: ["waiting"] })
      .mockResolvedValue({ pending: [] });
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        useWarmHome("account", true);
        return useHome(open ? "account" : null);
      },
      { initialProps: { open: false }, wrapper: wrapper(fetcher, 2000) },
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    rerender({ open: true });
    await act(() => vi.advanceTimersByTimeAsync(5500));
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("still reloads when Cue changes a lane after the hover's load", async () => {
    const fetcher = vi.fn(async () => ({ pending: [] }));
    const { rerender } = renderHook(
      ({ open }: { open: boolean }) => {
        useWarmHome("account", true);
        return useHome(open ? "account" : null);
      },
      { initialProps: { open: false }, wrapper: wrapper(fetcher, 2000) },
    );
    await act(() => vi.advanceTimersByTimeAsync(3000));
    rerender({ open: true });
    await act(async () => {
      announceTodayChanged();
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

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
    pending: [],
    failed: [],
  };
}

function wrapper(fetcher: () => Promise<unknown>, dedupingInterval = 0) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ fetcher, provider: () => new Map(), dedupingInterval }}>
      {children}
    </SWRConfig>
  );
}
