// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_DRAFT_STORAGE_KEY,
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  createBrowserCache,
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";

describe("createBrowserCache", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user-1");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a value per account until it expires", () => {
    const cache = briefs();
    cache.set("account-a", "thread-1", "Pay the invoice", 0);

    expect(cache.get("account-a", "thread-1", 999)).toBe("Pay the invoice");
    expect(cache.get("account-b", "thread-1", 999)).toBeUndefined();
    expect(cache.get("account-a", "thread-1", 10_000)).toBeUndefined();
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

  it("keeps each store within its size, dropping the oldest entries", () => {
    const cache = createBrowserCache<string>({
      name: "brief",
      ttlMs: 10_000,
      maxEntries: 100,
      maxBytes: 1000,
    });
    for (let i = 0; i < 20; i++)
      cache.set("account-a", `t${i}`, "x".repeat(100), i);

    expect(cache.get("account-a", "t19", 20)).toBeDefined();
    expect(cache.get("account-a", "t0", 20)).toBeUndefined();
    expect(storedBytes()).toBeLessThanOrEqual(1000);
  });

  it("gives up its oldest entries when storage is full", () => {
    const cache = briefs();
    cache.set("account-a", "old", "Old brief", 0);
    const setItem = Storage.prototype.setItem;
    let refusals = 1;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (refusals-- > 0) throw new DOMException("full", "QuotaExceededError");
      setItem.call(this, key, value);
    });

    cache.set("account-a", "new", "New brief", 1);

    expect(cache.get("account-a", "new", 2)).toBe("New brief");
    expect(cache.get("account-a", "old", 2)).toBeUndefined();
  });

  // Two tabs each write what they were given; neither erases the other's.
  it("keeps what another tab saved when saving its own", () => {
    const tabA = briefs();
    const tabB = briefs();
    tabA.set("account-a", "thread-1", "From tab A", 0);
    tabB.set("account-a", "thread-2", "From tab B", 1);

    expect(tabA.get("account-a", "thread-2", 2)).toBe("From tab B");
    expect(tabB.get("account-a", "thread-1", 2)).toBe("From tab A");
  });

  it("keeps each user's entries apart and drops another user's", () => {
    const cache = briefs();
    cache.set("account-a", "thread-1", "User 1's brief", 0);

    setBrowserCacheUser("user-2");

    expect(cache.get("account-a", "thread-1", 1)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it("keeps nothing until it knows who is signed in", () => {
    resetBrowserCacheForTesting(null);
    const cache = briefs();
    cache.set("account-a", "thread-1", "Brief", 0);

    expect(window.localStorage.length).toBe(0);
  });

  it("forgets everything on sign-out, the chat's unsent message too, and refuses late writes until someone signs in", () => {
    const cache = briefs();
    cache.set("account-a", "thread-1", "Pay the invoice", 0);

    window.localStorage.setItem(CHAT_DRAFT_STORAGE_KEY, '"Unsent question"');
    clearBrowserCaches();
    cache.set("account-a", "thread-2", "Late write", 0);

    expect(cache.get("account-a", "thread-1", 1)).toBeUndefined();
    expect(cache.get("account-a", "thread-2", 1)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);

    setBrowserCacheUser("user-1");
    cache.set("account-a", "thread-3", "After sign-in", 0);
    expect(cache.get("account-a", "thread-3", 1)).toBe("After sign-in");
  });

  it("forgets a removed account and keeps the others", () => {
    const cache = briefs();
    cache.set("account-a", "thread-1", "A", 0);
    cache.set("account-b", "thread-1", "B", 0);

    clearBrowserCachesForAccount("account-a");

    expect(cache.get("account-a", "thread-1", 1)).toBeUndefined();
    expect(cache.get("account-b", "thread-1", 1)).toBe("B");
  });

  it("deletes an expired entry when it is read, keeping the rest", () => {
    const cache = briefs();
    cache.set("account-a", "old", "Old brief", 0);
    cache.set("account-a", "new", "New brief", 5000);

    expect(cache.get("account-a", "old", 10_000)).toBeUndefined();
    expect(storedText()).not.toContain("Old brief");
    expect(cache.get("account-a", "new", 10_000)).toBe("New brief");

    expect(cache.get("account-a", "new", 20_000)).toBeUndefined();
    expect(window.localStorage.length).toBe(0);
  });

  it("forgets accounts the signed-in user no longer has", () => {
    const cache = briefs();
    cache.set("account-a", "thread-1", "A", 0);
    cache.set("account-b", "thread-1", "B", 0);

    // Account B was removed on another device.
    setBrowserCacheUser("user-1", ["account-a"]);

    expect(cache.get("account-a", "thread-1", 1)).toBe("A");
    expect(cache.get("account-b", "thread-1", 1)).toBeUndefined();
    expect(storedText()).not.toContain('"B"');

    // Without a list nothing more is dropped.
    setBrowserCacheUser("user-1");
    expect(cache.get("account-a", "thread-1", 1)).toBe("A");
  });
});

function briefs() {
  return createBrowserCache<string>({
    name: "brief",
    ttlMs: 10_000,
    maxEntries: 10,
  });
}

function storedText() {
  return Object.keys(window.localStorage)
    .map((key) => window.localStorage.getItem(key))
    .join("");
}

function storedBytes() {
  let total = 0;
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    if (key) total += window.localStorage.getItem(key)?.length ?? 0;
  }
  return total;
}
