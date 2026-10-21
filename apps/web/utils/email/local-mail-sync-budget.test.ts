import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import {
  forgetEmailProviderRateLimitState,
  getEmailProviderRateLimitStateFromRedis,
  isEmailProviderRateLimitRedisConfigured,
} from "@/utils/redis/email-provider-rate-limit";
import {
  LocalMailSyncPausedError,
  withLocalMailSyncBudget,
} from "./local-mail-sync-budget";

vi.mock("@/utils/redis", () => ({ redis: { eval: vi.fn() } }));
vi.mock("@/utils/redis/email-provider-rate-limit");
const input = {
  emailAccountId: "account-1",
  provider: "google",
  priority: "backfill",
  cost: 500,
} as const;
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(isEmailProviderRateLimitRedisConfigured).mockReturnValue(true);
  vi.mocked(getEmailProviderRateLimitStateFromRedis).mockResolvedValue(null);
  vi.mocked(redis.eval).mockResolvedValue(0);
});
describe("local mail sync admission", () => {
  it("does not contact the provider when Redis is unavailable or unconfigured", async () => {
    const operation = vi.fn();
    vi.mocked(redis.eval).mockRejectedValueOnce(new Error("unavailable"));
    await expect(
      withLocalMailSyncBudget(input, operation),
    ).rejects.toBeInstanceOf(LocalMailSyncPausedError);
    vi.mocked(isEmailProviderRateLimitRedisConfigured).mockReturnValue(false);
    await expect(
      withLocalMailSyncBudget(input, operation),
    ).rejects.toBeInstanceOf(LocalMailSyncPausedError);
    expect(operation).not.toHaveBeenCalled();
  });
  it("honors an existing account cooldown before acquiring a reservation", async () => {
    vi.mocked(getEmailProviderRateLimitStateFromRedis).mockResolvedValue({
      provider: "google",
      retryAt: new Date(Date.now() + 120_000),
    });
    const operation = vi.fn();
    await expect(
      withLocalMailSyncBudget(input, operation),
    ).rejects.toMatchObject({ retryAfterMs: expect.any(Number) });
    expect(redis.eval).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
  });
  it("leaves admission denial to the scheduler without retrying or recording provider throttling", async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce(20_000);
    const operation = vi.fn();
    await expect(
      withLocalMailSyncBudget(input, operation),
    ).rejects.toMatchObject({ retryAfterMs: 20_000 });
    expect(redis.eval).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });
  it("reserves every hydration subrequest up front and releases its owned slots", async () => {
    const operation = vi.fn().mockResolvedValue("page");
    await expect(withLocalMailSyncBudget(input, operation)).resolves.toBe(
      "page",
    );
    const [, keys, args] = vi.mocked(redis.eval).mock.calls[0]!;
    expect(keys).toContain("local-mail-budget:google:total");
    expect(keys).toContain("local-mail-budget:google:account-1:total");
    expect(args).toEqual([
      "500",
      "10000",
      "360000",
      "5000",
      "180000",
      expect.any(String),
    ]);
    expect(redis.eval).toHaveBeenLastCalledWith(
      expect.any(String),
      keys.slice(4, 6),
      [args[5]],
    );
    expect(operation).toHaveBeenCalledWith(expect.any(AbortSignal), {
      nextAdmitAfterMs: null,
    });
  });
  it("tells an admitted request when the budget will admit the caller's next one", async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce([0, "", 6540]);
    const operation = vi.fn().mockResolvedValue("page");
    await expect(
      withLocalMailSyncBudget({ ...input, nextCost: 545 }, operation),
    ).resolves.toBe("page");
    expect(vi.mocked(redis.eval).mock.calls[0]?.[2]?.[6]).toBe("545");
    expect(operation).toHaveBeenCalledWith(expect.any(AbortSignal), {
      nextAdmitAfterMs: 6540,
    });
  });
  it("reports no wait when the budget already covers the next request", async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce([0, "", 0]);
    const operation = vi.fn().mockResolvedValue("page");
    await withLocalMailSyncBudget({ ...input, nextCost: 545 }, operation);
    expect(operation).toHaveBeenCalledWith(expect.any(AbortSignal), {
      nextAdmitAfterMs: null,
    });
  });
  it("leaves a reserved current-work allowance above the backfill ceiling", async () => {
    await withLocalMailSyncBudget(
      { ...input, priority: "current" },
      async () => undefined,
    );
    expect(vi.mocked(redis.eval).mock.calls[0]?.[2]).toEqual([
      "500",
      "10000",
      "360000",
      "0",
      "0",
      expect.any(String),
    ]);
  });
  it("records real Retry-After across devices and preserves the original error", async () => {
    const error = {
      status: 429,
      message: "Rate limit exceeded",
      response: { headers: { "retry-after": "120" } },
    };
    await expect(
      withLocalMailSyncBudget(input, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(redis.eval).toHaveBeenCalledTimes(3);
    const [, keys, args] = vi.mocked(redis.eval).mock.calls[1]!;
    expect(keys).toContain("email-provider-rate-limit:account-1");
    expect(JSON.parse(String(args[1]))).toMatchObject({
      provider: "google",
      source: "local-mail",
    });
    expect(Number(args[2])).toBeGreaterThanOrEqual(120_000);
  });
  // The script writes account-wide rate-limit mode behind the instance's
  // memo of that state, so the memo must reread it rather than serve "none".
  it("makes this instance reread rate-limit mode after current work sets it", async () => {
    const error = {
      status: 429,
      message: "Rate limit exceeded",
      response: { headers: { "retry-after": "120" } },
    };
    await expect(
      withLocalMailSyncBudget({ ...input, priority: "current" }, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(forgetEmailProviderRateLimitState).toHaveBeenCalledWith("account-1");
  });
  it("leaves rate-limit mode alone when a backfill is throttled", async () => {
    const error = {
      status: 429,
      message: "Rate limit exceeded",
      response: { headers: { "retry-after": "120" } },
    };
    await expect(
      withLocalMailSyncBudget(input, async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(forgetEmailProviderRateLimitState).not.toHaveBeenCalled();
  });
  it("records the Graph SDK's direct response headers", async () => {
    const error = {
      statusCode: 429,
      headers: new Headers({ "Retry-After": "90" }),
    };
    await expect(
      withLocalMailSyncBudget(
        { ...input, provider: "microsoft", cost: 1 },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);
    expect(
      Number(vi.mocked(redis.eval).mock.calls[1]?.[2]?.[2]),
    ).toBeGreaterThanOrEqual(90_000);
  });
  it("aborts outstanding work when its shared lease cannot be renewed", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(redis.eval)
        .mockResolvedValueOnce(0)
        .mockRejectedValueOnce(new Error("unavailable"))
        .mockResolvedValue(1);
      let signal: AbortSignal | undefined;
      let finish: (() => void) | undefined;
      const operation = withLocalMailSyncBudget(input, (received) => {
        signal = received;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal?.aborted).toBe(true);
      finish?.();
      await expect(operation).rejects.toBeInstanceOf(LocalMailSyncPausedError);
    } finally {
      vi.useRealTimers();
    }
  });
  it("returns a typed pause when a provider rejects after the request timeout", async () => {
    vi.useFakeTimers();
    try {
      vi.mocked(redis.eval).mockResolvedValueOnce(0).mockResolvedValue(1);
      const operation = withLocalMailSyncBudget(
        { ...input, provider: "microsoft", cost: 1 },
        (signal) =>
          new Promise<void>((_, reject) =>
            signal.addEventListener("abort", () =>
              reject(new DOMException("Aborted", "AbortError")),
            ),
          ),
      );
      const assertion = expect(operation).rejects.toBeInstanceOf(
        LocalMailSyncPausedError,
      );
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
  it("fails closed on malformed admission responses", async () => {
    vi.mocked(redis.eval).mockResolvedValueOnce(null);
    const operation = vi.fn();
    await expect(
      withLocalMailSyncBudget(input, operation),
    ).rejects.toBeInstanceOf(LocalMailSyncPausedError);
    expect(operation).not.toHaveBeenCalled();
  });
  it("rejects work larger than a bounded reservation", async () => {
    await expect(
      withLocalMailSyncBudget({ ...input, cost: 3101 }, vi.fn()),
    ).rejects.toThrow("Invalid local mail sync reservation");
    expect(redis.eval).not.toHaveBeenCalled();
  });
});
