// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { syncWithRetry } from "@/utils/web-push/sync-with-retry";

const MINUTE_MS = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("syncWithRetry", () => {
  it("backs off after failures, then leaves it to the reader returning", async () => {
    const sync = vi.fn(async () => false);
    const onFailure = vi.fn();
    const stop = syncWithRetry({ sync, onFailure });
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5 * MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(15 * MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(4);
    expect(onFailure).toHaveBeenCalledTimes(4);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(5);
    stop();
  });

  it("tries again as soon as the reader comes back, and stops once it works", async () => {
    const sync = vi
      .fn<() => Promise<boolean>>()
      .mockRejectedValueOnce(new Error("no service worker"))
      .mockResolvedValue(true);
    syncWithRetry({ sync, onFailure: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(sync).toHaveBeenCalledTimes(2);

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("does nothing more once stopped", async () => {
    const sync = vi.fn(async () => false);
    const stop = syncWithRetry({ sync, onFailure: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    stop();

    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(30 * MINUTE_MS);
    expect(sync).toHaveBeenCalledTimes(1);
  });
});
