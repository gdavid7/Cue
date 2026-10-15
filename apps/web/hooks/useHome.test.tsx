// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { announceTodayChanged } from "@/utils/home/today-changes";
import { useHome } from "./useHome";

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

    await act(async () => {
      announceTodayChanged();
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(fetcher).toHaveBeenCalledTimes(2);
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

function wrapper(fetcher: () => Promise<unknown>) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig
      value={{ fetcher, provider: () => new Map(), dedupingInterval: 0 }}
    >
      {children}
    </SWRConfig>
  );
}
