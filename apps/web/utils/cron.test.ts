import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  hasCronSecret,
  hasPostCronSecret,
  isAuthorizedCronOrInternalRequest,
  runCronJob,
} from "./cron";
import type { RequestWithLogger } from "@/utils/middleware";
import { createTestLogger } from "@/__tests__/helpers";

const logger = createTestLogger();

vi.mock("@/env", () => ({
  env: { CRON_SECRET: "test-secret-123", INTERNAL_API_KEY: "test-api-key" },
}));

function createMockRequestWithLogger(
  headers?: Record<string, string>,
): RequestWithLogger {
  const request = new Request("https://example.com", {
    headers: headers ? new Headers(headers) : undefined,
  });
  return {
    ...request,
    headers: request.headers,
    logger,
  } as RequestWithLogger;
}

describe("hasCronSecret", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("should return true for valid authorization header", () => {
    const request = createMockRequestWithLogger({
      authorization: "Bearer test-secret-123",
    });

    expect(hasCronSecret(request)).toBe(true);
  });

  it("should return false for invalid authorization header", () => {
    const request = createMockRequestWithLogger({
      authorization: "Bearer wrong-secret",
    });

    expect(hasCronSecret(request)).toBe(false);
  });

  it("should return false for missing authorization header", () => {
    const request = createMockRequestWithLogger();

    expect(hasCronSecret(request)).toBe(false);
  });

  it("should return false for malformed authorization header", () => {
    const request = createMockRequestWithLogger({
      authorization: "test-secret-123", // Missing "Bearer" prefix
    });

    expect(hasCronSecret(request)).toBe(false);
  });

  it("does not log the presented secret on failure", () => {
    const errorSpy = vi.spyOn(logger, "error");
    const request = createMockRequestWithLogger({
      authorization: "Bearer leaked-guess-456",
    });

    expect(hasCronSecret(request)).toBe(false);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "leaked-guess-456",
    );
  });
});

describe("hasPostCronSecret", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not log the presented secret or body on failure", async () => {
    const errorSpy = vi.spyOn(logger, "error");
    const request = Object.assign(
      new Request("https://example.com", {
        method: "POST",
        body: JSON.stringify({ CRON_SECRET: "leaked-guess-456" }),
      }),
      { logger },
    ) as RequestWithLogger;

    expect(await hasPostCronSecret(request)).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(
      "leaked-guess-456",
    );
  });
});

describe("isAuthorizedCronOrInternalRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts an internal API key without logging a failed cron check", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = createMockRequestWithLogger({
      "x-api-key": "test-api-key",
    });

    expect(isAuthorizedCronOrInternalRequest(request)).toBe(true);
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("accepts a valid cron secret", () => {
    const request = createMockRequestWithLogger({
      authorization: "Bearer test-secret-123",
    });

    expect(isAuthorizedCronOrInternalRequest(request)).toBe(true);
  });

  it("rejects and logs a request with neither credential", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const request = createMockRequestWithLogger();

    expect(isAuthorizedCronOrInternalRequest(request)).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe("runCronJob", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("logs one finished line with the run's counts, even when there was nothing to do", async () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");

    const result = await runCronJob({
      logger,
      run: async () => ({ processed: 0, firstHourHealth: { sent: 0 } }),
    });

    expect(result).toEqual({ processed: 0, firstHourHealth: { sent: 0 } });
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("Cron finished", {
      durationMs: expect.any(Number),
      processed: 0,
      firstHourHealth: { sent: 0 },
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when a run gets close to the route's limit", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(logger, "warn");

    await runCronJob({
      logger,
      run: async () => {
        vi.advanceTimersByTime(241_000);
        return { processed: 1 };
      },
    });

    expect(warn).toHaveBeenCalledWith("Cron ran long", {
      durationMs: 241_000,
      thresholdMs: 240_000,
    });
  });

  it("logs a failed run with its duration, warns when it ran long, and rethrows", async () => {
    vi.useFakeTimers();
    const info = vi.spyOn(logger, "info");
    const error = vi.spyOn(logger, "error");
    const warn = vi.spyOn(logger, "warn");
    const failure = new Error("database unavailable");

    await expect(
      runCronJob({
        logger,
        run: async () => {
          vi.advanceTimersByTime(250_000);
          throw failure;
        },
      }),
    ).rejects.toBe(failure);

    expect(info).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Cron failed", {
      durationMs: 250_000,
      error: failure,
    });
    expect(warn).toHaveBeenCalledWith("Cron ran long", {
      durationMs: 250_000,
      thresholdMs: 240_000,
    });
  });
});
