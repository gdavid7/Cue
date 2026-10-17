import { describe, expect, it, vi } from "vitest";
import { EMAIL_ACCOUNT_ID_REQUIRED_ERROR } from "@/utils/config";
import {
  getAccountScopedKey,
  getDevSWRErrorRetryMs,
  getRetryHint,
  onSWRErrorRetry,
  shouldRevalidateAllLiveSwrKeysForAccountId,
  shouldResetSwrCacheForAccountId,
} from "./swr";

describe("getAccountScopedKey", () => {
  it("keeps an unscoped path when no account id argument is passed", () => {
    expect(getAccountScopedKey("/api/user/email-account")).toBe(
      "/api/user/email-account",
    );
  });

  it("does not fetch when the account id is missing", () => {
    expect(getAccountScopedKey("/api/user/email-account", null)).toBeNull();
    expect(getAccountScopedKey("/api/user/email-account", "")).toBeNull();
  });

  it("scopes the cache key to the account", () => {
    expect(getAccountScopedKey("/api/user/email-account", "account-1")).toEqual(
      ["/api/user/email-account", "account-1"],
    );
  });
});

describe("shouldResetSwrCacheForAccountId", () => {
  it("does not reset on the first account id", () => {
    expect(shouldResetSwrCacheForAccountId(null, "account-1")).toBe(false);
  });

  it("resets when an account id appears after an empty id", () => {
    expect(shouldResetSwrCacheForAccountId("", "account-1")).toBe(true);
  });

  it("resets when switching accounts", () => {
    expect(shouldResetSwrCacheForAccountId("account-1", "account-2")).toBe(
      true,
    );
  });

  it("does not reset for the same account or an empty next id", () => {
    expect(shouldResetSwrCacheForAccountId("account-1", "account-1")).toBe(
      false,
    );
    expect(shouldResetSwrCacheForAccountId("account-1", "")).toBe(false);
  });
});

describe("shouldRevalidateAllLiveSwrKeysForAccountId", () => {
  it("revalidates when an account id appears after an empty id", () => {
    expect(shouldRevalidateAllLiveSwrKeysForAccountId("", "account-1")).toBe(
      true,
    );
  });

  it("does not revalidate on first paint, account switch, or an empty next id", () => {
    expect(shouldRevalidateAllLiveSwrKeysForAccountId(null, "account-1")).toBe(
      false,
    );
    expect(
      shouldRevalidateAllLiveSwrKeysForAccountId("account-1", "account-2"),
    ).toBe(false);
    expect(shouldRevalidateAllLiveSwrKeysForAccountId("", "")).toBe(false);
    expect(shouldRevalidateAllLiveSwrKeysForAccountId("account-1", "")).toBe(
      false,
    );
  });
});

describe("getDevSWRErrorRetryMs", () => {
  it("retries HMR 404s quickly", () => {
    expect(getDevSWRErrorRetryMs({ status: 404 }, 0)).toBe(500);
  });

  it("retries a missing account-id 403 until the header can be sent", () => {
    expect(
      getDevSWRErrorRetryMs(
        { status: 403, message: EMAIL_ACCOUNT_ID_REQUIRED_ERROR },
        0,
      ),
    ).toBe(500);
    expect(
      getDevSWRErrorRetryMs(
        { status: 403, message: EMAIL_ACCOUNT_ID_REQUIRED_ERROR },
        5,
      ),
    ).toBeNull();
  });

  it("does not retry other client errors", () => {
    expect(
      getDevSWRErrorRetryMs(
        { status: 403, message: "Insufficient permissions" },
        0,
      ),
    ).toBeNull();
    expect(getDevSWRErrorRetryMs({ status: 400 }, 0)).toBeNull();
  });

  it("backs off server errors", () => {
    expect(getDevSWRErrorRetryMs({ status: 500 }, 0)).toBe(5000);
    expect(getDevSWRErrorRetryMs({ status: 500 }, 1)).toBe(10_000);
  });
});

describe("onSWRErrorRetry", () => {
  it("retries a rate-limited request once, after the limit's window", () => {
    vi.useFakeTimers();
    try {
      const revalidate = vi.fn();
      const config = { errorRetryInterval: 5000 } as never;
      onSWRErrorRetry({ status: 429 }, "key", config, revalidate, {
        retryCount: 1,
      });
      vi.advanceTimersByTime(30_000);
      expect(revalidate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(30_000);
      expect(revalidate).toHaveBeenCalledTimes(1);

      onSWRErrorRetry({ status: 429 }, "key", config, revalidate, {
        retryCount: 2,
      });
      vi.advanceTimersByTime(10 * 60_000);
      expect(revalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits out a deferral's Retry-After, give or take a quarter, before asking again", () => {
    vi.useFakeTimers();
    try {
      const revalidate = vi.fn();
      retryDeferral(27_000, revalidate);
      vi.advanceTimersByTime(20_000);
      expect(revalidate).not.toHaveBeenCalled();
      vi.advanceTimersByTime(14_000);
      expect(revalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds a deferral's retry until a hidden tab is back", () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), {
      visibilityState: "hidden",
    });
    vi.stubGlobal("document", page);
    try {
      const revalidate = vi.fn();
      retryDeferral(1000, revalidate);
      vi.advanceTimersByTime(10 * 60_000);
      expect(revalidate).not.toHaveBeenCalled();

      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
      expect(revalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it("keeps SWR's backoff for other errors", () => {
    vi.useFakeTimers();
    try {
      const revalidate = vi.fn();
      onSWRErrorRetry(
        { status: 500 },
        "key",
        { errorRetryInterval: 5000 } as never,
        revalidate,
        { retryCount: 1 },
      );
      vi.advanceTimersByTime(20_000);
      expect(revalidate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("getRetryHint", () => {
  it("waits a deferral's Retry-After, kept between a second and 90 seconds", () => {
    const deferred = (retryAfterMs: number, jitter: number) =>
      getRetryHint({ status: 503, retryAfterMs }, 1, jitter);

    expect(deferred(27_000, 1)).toEqual({ kind: "wait", ms: 27_000 });
    expect(deferred(0, 1)).toEqual({ kind: "wait", ms: 1000 });
    expect(deferred(60 * 60_000, 1)).toEqual({ kind: "wait", ms: 90_000 });
    expect(deferred(60 * 60_000, 1.25)).toEqual({ kind: "wait", ms: 112_500 });
    expect(deferred(20_000, 0.75)).toEqual({ kind: "wait", ms: 15_000 });
  });

  it("retries a rate limit once, then stops", () => {
    expect(getRetryHint({ status: 429 }, 1)).toEqual({
      kind: "wait",
      ms: 60_000,
    });
    expect(getRetryHint({ status: 429 }, 2)).toEqual({ kind: "stop" });
  });

  it("leaves errors without a hint to the usual backoff", () => {
    expect(getRetryHint({ status: 503 }, 1)).toEqual({ kind: "backoff" });
    expect(getRetryHint({ status: 500 }, 1)).toEqual({ kind: "backoff" });
    expect(getRetryHint(undefined, 1)).toEqual({ kind: "backoff" });
  });
});

function retryDeferral(retryAfterMs: number, revalidate: () => void) {
  onSWRErrorRetry(
    { status: 503, retryAfterMs },
    "key",
    { errorRetryInterval: 5000 } as never,
    revalidate,
    { retryCount: 1 } as never,
  );
}
