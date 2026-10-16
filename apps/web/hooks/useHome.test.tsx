// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTodayChanged } from "@/utils/home/today-changes";
import { useHome, useWarmHome } from "./useHome";

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

describe("useWarmHome", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
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
});

function wrapper(fetcher: () => Promise<unknown>, dedupingInterval = 0) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig value={{ fetcher, provider: () => new Map(), dedupingInterval }}>
      {children}
    </SWRConfig>
  );
}
