import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReaderPrefetcher } from "@/utils/reader-prefetch";

describe("createReaderPrefetcher", () => {
  let clock: number;
  let report: ReturnType<typeof vi.fn>;
  let prefetcher: ReturnType<typeof createReaderPrefetcher>;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 0;
    report = vi.fn();
    prefetcher = createReaderPrefetcher({
      delayMs: 300,
      ttlMs: 60_000,
      now: () => clock,
      report,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts nothing for a pointer that passes over a row", () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    prefetcher.intend(intent("t1", run));
    vi.advanceTimersByTime(299);
    prefetcher.cancel("t1");
    vi.advanceTimersByTime(1000);

    expect(run).not.toHaveBeenCalled();
  });

  it("starts the request once the pointer has rested on the row", () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    prefetcher.intend(intent("t1", run));
    vi.advanceTimersByTime(300);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("only starts the latest of several rows hovered in turn", () => {
    const first = vi.fn(() => Promise.resolve("a"));
    const second = vi.fn(() => Promise.resolve("b"));
    prefetcher.intend(intent("t1", first));
    vi.advanceTimersByTime(200);
    prefetcher.intend(intent("t2", second));
    vi.advanceTimersByTime(300);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("starts no second prefetch for an account while one is in flight", () => {
    const first = vi.fn(() => new Promise(() => {}));
    const second = vi.fn(() => Promise.resolve("b"));
    prefetcher.intend(intent("t1", first));
    vi.advanceTimersByTime(300);
    prefetcher.intend(intent("t2", second));
    vi.advanceTimersByTime(300);

    expect(second).not.toHaveBeenCalled();
  });

  it("lets another account prefetch while one is in flight", () => {
    prefetcher.intend(intent("t1", () => new Promise(() => {})));
    vi.advanceTimersByTime(300);
    const other = vi.fn(() => Promise.resolve("b"));
    prefetcher.intend(intent("t2", other, "account-2"));
    vi.advanceTimersByTime(300);

    expect(other).toHaveBeenCalledTimes(1);
  });

  it("hands the reader the prefetched request once, by its key", async () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    prefetcher.intend(intent("t1", run));
    vi.advanceTimersByTime(300);

    await expect(prefetcher.take(["/brief?t1", "account-1"])).resolves.toBe(
      "brief",
    );
    expect(prefetcher.take(["/brief?t1", "account-1"])).toBeUndefined();
    expect(report).toHaveBeenCalledWith("used");
  });

  it("doesn't hand over a failed prefetch, so the reader asks again", async () => {
    prefetcher.intend(intent("t1", () => Promise.reject(new Error("503"))));
    vi.advanceTimersByTime(300);
    await vi.runAllTimersAsync();

    expect(prefetcher.take(["/brief?t1", "account-1"])).toBeUndefined();
    expect(report).toHaveBeenCalledWith("failed");
  });

  it("asks once for a row hovered again while its prefetch is kept", async () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    prefetcher.intend(intent("t1", run));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    prefetcher.cancel("t1");
    prefetcher.intend(intent("t1", run));
    vi.advanceTimersByTime(300);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("counts a prefetch the reader never took as unused once it expires", async () => {
    prefetcher.intend(intent("t1", () => Promise.resolve("brief")));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    clock += 60_000;

    expect(prefetcher.take(["/brief?t1", "account-1"])).toBeUndefined();
    expect(report).toHaveBeenCalledWith("unused");
  });

  it("starts at most six prefetches a minute for an account", async () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    for (let i = 0; i < 8; i++) {
      prefetcher.intend(intent(`t${i}`, run));
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    }
    expect(run).toHaveBeenCalledTimes(6);

    clock += 60_000;
    prefetcher.intend(intent("t9", run));
    vi.advanceTimersByTime(300);
    expect(run).toHaveBeenCalledTimes(7);
  });

  it("drops a pending intent when the list goes away", () => {
    const run = vi.fn(() => Promise.resolve("brief"));
    prefetcher.intend(intent("t1", run));
    prefetcher.cancelPending();
    vi.advanceTimersByTime(1000);

    expect(run).not.toHaveBeenCalled();
  });

  it("counts what is left as unused when the page goes away", async () => {
    prefetcher.intend(intent("t1", () => Promise.resolve("brief")));
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    prefetcher.flush();

    expect(report).toHaveBeenCalledWith("unused");
  });
});

function intent(
  threadId: string,
  run: () => Promise<unknown>,
  accountId = "account-1",
) {
  return {
    accountId,
    threadId,
    request: () => ({ key: [`/brief?${threadId}`, accountId], run }),
  };
}
