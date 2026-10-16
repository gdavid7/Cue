import { afterEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";
import { runWithRequestDeadline } from "@/utils/request-deadline";
import { sleep } from "@/utils/sleep";
import { getRetryAfterDelayMs, withProviderRetry } from "./provider-retry";

describe("getRetryAfterDelayMs", () => {
  it("uses Retry-After header in seconds", () => {
    expect(getRetryAfterDelayMs("10")).toBe(10_000);
    expect(getRetryAfterDelayMs("0")).toBe(0);
  });

  it("uses Retry-After header as HTTP-date", () => {
    const futureDate = new Date(Date.now() + 5000);
    const delay = getRetryAfterDelayMs(futureDate.toUTCString());
    expect(delay).toBeGreaterThanOrEqual(4000);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("lets callers fall back when Retry-After header is stale", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString();
    expect(getRetryAfterDelayMs(pastDate)).toBeUndefined();
  });

  it("lets callers fall back when Retry-After header is missing or invalid", () => {
    expect(getRetryAfterDelayMs(undefined)).toBeUndefined();
    expect(getRetryAfterDelayMs("not a date")).toBeUndefined();
  });
});

describe("withProviderRetry under a request deadline", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives up with the provider's error instead of waiting past the deadline", async () => {
    vi.useFakeTimers();
    const refusal = new Error("Rate limit exceeded");
    const operation = vi.fn().mockRejectedValue(refusal);
    const startedAt = Date.now();

    const outcome = runWithRequestDeadline(30, () =>
      withProviderRetry(operation, retryOptions()),
    ).catch((error: unknown) => error);
    await vi.runAllTimersAsync();

    expect(await outcome).toBe(refusal);
    // A 30s route keeps 20s: waits of 1, 2, 4 and 8 seconds fit, and the
    // next 10 would not.
    expect(operation).toHaveBeenCalledTimes(5);
    expect(Date.now() - startedAt).toBeLessThanOrEqual(20_000);
  });

  it("waits only its own backoff between attempts, and none after the last", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(new Error("Rate limit"));
    const startedAt = Date.now();

    const outcome = withProviderRetry(operation, retryOptions()).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await outcome;

    expect(operation).toHaveBeenCalledTimes(6);
    // 1 + 2 + 4 + 8 + 10 seconds between six attempts.
    expect(Date.now() - startedAt).toBe(25_000);
  });

  it("keeps every retry for work with no deadline", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(new Error("Rate limit"));

    const outcome = withProviderRetry(operation, retryOptions()).catch(
      (error: unknown) => error,
    );
    await vi.runAllTimersAsync();
    await outcome;

    expect(operation).toHaveBeenCalledTimes(6);
  });

  it("drops the deadline for work the request leaves running", async () => {
    vi.useFakeTimers();
    const operation = vi.fn().mockRejectedValue(new Error("Rate limit"));
    let leftRunning: Promise<unknown> = Promise.resolve();

    await runWithRequestDeadline(30, async () => {
      leftRunning = (async () => {
        await sleep(1);
        return withProviderRetry(operation, retryOptions());
      })().catch((error: unknown) => error);
    });
    await vi.runAllTimersAsync();
    await leftRunning;

    expect(operation).toHaveBeenCalledTimes(6);
  });
});

function retryOptions() {
  return {
    providerName: "Test",
    logger: createScopedLogger("provider-retry-test"),
    maxRetries: 5,
    maxBlockingDelayMs: 10_000,
    retryPolicy: "all" as const,
    classify: ({ attemptNumber }: { attemptNumber: number }) => ({
      retryable: true,
      isRateLimit: true,
      delayMs: Math.min(1000 * 2 ** (attemptNumber - 1), 10_000),
      logFields: {},
    }),
  };
}
