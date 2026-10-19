// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  createBrowserCache,
  resetBrowserCacheBlocksForTesting,
} from "@/utils/browser-cache";

describe("createBrowserCache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheBlocksForTesting();
  });

  it("keeps a value per account until it expires", () => {
    const cache = createBrowserCache<string>({
      name: "brief",
      ttlMs: 1000,
      maxEntries: 10,
    });
    cache.set("account-a", "thread-1", "Pay the invoice", 0);

    expect(cache.get("account-a", "thread-1", 999)).toBe("Pay the invoice");
    expect(cache.get("account-b", "thread-1", 999)).toBeUndefined();
    expect(cache.get("account-a", "thread-1", 1000)).toBeUndefined();
  });

  it("drops the oldest entries past its limit", () => {
    const cache = createBrowserCache<number>({
      name: "brief",
      ttlMs: 10_000,
      maxEntries: 2,
    });
    cache.set("account-a", "one", 1, 1);
    cache.set("account-a", "two", 2, 2);
    cache.set("account-a", "three", 3, 3);

    expect(cache.get("account-a", "one", 4)).toBeUndefined();
    expect(cache.get("account-a", "two", 4)).toBe(2);
    expect(cache.get("account-a", "three", 4)).toBe(3);
  });

  it("forgets everything on sign-out and refuses late writes", () => {
    const cache = createBrowserCache<string>({
      name: "brief",
      ttlMs: 10_000,
      maxEntries: 10,
    });
    cache.set("account-a", "thread-1", "Pay the invoice", 0);

    clearBrowserCaches();
    cache.set("account-a", "thread-2", "Late write", 0);

    expect(cache.get("account-a", "thread-1", 1)).toBeUndefined();
    expect(cache.get("account-a", "thread-2", 1)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it("forgets a removed account and keeps the others", () => {
    const cache = createBrowserCache<string>({
      name: "brief",
      ttlMs: 10_000,
      maxEntries: 10,
    });
    cache.set("account-a", "thread-1", "A", 0);
    cache.set("account-b", "thread-1", "B", 0);

    clearBrowserCachesForAccount("account-a");

    expect(cache.get("account-a", "thread-1", 1)).toBeUndefined();
    expect(cache.get("account-b", "thread-1", 1)).toBe("B");
  });
});
