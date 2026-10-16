import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoCache } from "./memo-cache";

describe("createMemoCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads a key once while it is fresh, then again once it expires", async () => {
    vi.useFakeTimers();
    const cache = createMemoCache<string>({ ttlMs: 60_000, maxEntries: 10 });
    const load = vi.fn(async () => "value");

    await cache.get("a", load);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(60_001);
    await cache.get("a", load);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("shares one load between concurrent callers", async () => {
    const cache = createMemoCache<number>({ ttlMs: 60_000, maxEntries: 10 });
    const load = vi.fn(async () => 1);

    await Promise.all([cache.get("a", load), cache.get("a", load)]);

    expect(load).toHaveBeenCalledOnce();
  });

  it("does not keep a failed load, so the next caller retries", async () => {
    const cache = createMemoCache<number>({ ttlMs: 60_000, maxEntries: 10 });
    const load = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error("down"))
      .mockResolvedValue(2);

    await expect(cache.get("a", load)).rejects.toThrow("down");
    expect(await cache.get("a", load)).toBe(2);
  });

  it("skips values the caller says not to keep", async () => {
    const cache = createMemoCache<string | null>({
      ttlMs: 60_000,
      maxEntries: 10,
      keep: (value) => value !== null,
    });
    const load = vi.fn(async () => null);

    await cache.get("a", load);
    await cache.get("a", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("forgets a key on request and bounds its size", async () => {
    const cache = createMemoCache<string>({ ttlMs: 60_000, maxEntries: 2 });
    const load = vi.fn(async (key: string) => key);

    await cache.get("a", () => load("a"));
    cache.delete("a");
    await cache.get("a", () => load("a"));
    await cache.get("b", () => load("b"));
    await cache.get("c", () => load("c"));
    await cache.get("a", () => load("a"));

    expect(load.mock.calls.map(([key]) => key)).toEqual([
      "a",
      "a",
      "b",
      "c",
      "a",
    ]);
  });
});
