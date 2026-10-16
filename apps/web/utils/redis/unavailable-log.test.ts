import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/utils/logger";
import { logRedisFailureOnce } from "./unavailable-log";

describe("logRedisFailureOnce", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  // A refusing Redis fails every call; one line per instance says so without
  // a log per AI call or Gmail request.
  it("logs a failure once per instance until the quiet period passes", () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() } as unknown as Logger;

    for (let i = 0; i < 5; i++)
      logRedisFailureOnce(logger, "Error saving weekly usage cost", {
        error: new Error("max requests limit exceeded"),
      });
    logRedisFailureOnce(logger, "Failed to evaluate nano model guard", {});

    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "Error saving weekly usage cost",
      expect.objectContaining({ suppressedSinceLastLog: 0 }),
    );

    vi.advanceTimersByTime(10 * 60_000);
    logRedisFailureOnce(logger, "Error saving weekly usage cost", {});

    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenLastCalledWith(
      "Error saving weekly usage cost",
      expect.objectContaining({ suppressedSinceLastLog: 4 }),
    );
  });
});
