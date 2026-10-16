import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import { ProviderRateLimitModeError } from "@/utils/email/rate-limit-mode-error";
import { createTestLogger } from "@/__tests__/helpers";
import {
  assertProviderNotRateLimited,
  getEmailProviderRateLimitState,
  getProviderRateLimitDelayMs,
  recordRateLimitFromApiError,
  recordProviderRateLimitFromError,
  setEmailProviderRateLimitState,
  withRateLimitRecording,
} from "./rate-limit";

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
  },
}));

const logger = createTestLogger();

describe("email provider rate-limit state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets and reads redis-backed rate-limit state", async () => {
    const retryAt = new Date(Date.now() + 60_000);
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    await setEmailProviderRateLimitState({
      emailAccountId: "account-1",
      provider: "google",
      retryAt,
      source: "test",
      logger,
    });

    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );

    vi.mocked(redis.get).mockResolvedValueOnce(
      JSON.stringify({
        provider: "google",
        retryAt: retryAt.toISOString(),
        source: "test",
        detectedAt: new Date().toISOString(),
      }),
    );

    const state = await getEmailProviderRateLimitState({
      emailAccountId: "account-1",
    });

    expect(state?.retryAt.toISOString()).toBe(retryAt.toISOString());
    expect(state?.source).toBe("test");
  });

  it("keeps ttl aligned to retryAt even for long windows", async () => {
    const retryAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    await setEmailProviderRateLimitState({
      emailAccountId: "account-1",
      provider: "google",
      retryAt,
      logger,
    });

    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );

    const options = vi.mocked(redis.set).mock.calls[0]?.[2] as
      | { ex?: number }
      | undefined;
    expect(options?.ex).toBeDefined();
    expect(options!.ex!).toBeGreaterThan(60 * 60);
  });

  it("clears stale rate-limit entries", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(
      JSON.stringify({
        provider: "google",
        retryAt: new Date(Date.now() - 5000).toISOString(),
        detectedAt: new Date().toISOString(),
      }),
    );

    const state = await getEmailProviderRateLimitState({
      emailAccountId: "account-1",
    });

    expect(state).toBeNull();
    expect(redis.del).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
    );
  });

  it("returns null when reading rate-limit state fails", async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error("redis unavailable"));

    const state = await getEmailProviderRateLimitState({
      emailAccountId: "account-1",
    });

    expect(state).toBeNull();
  });

  it("throws a typed error when account is currently rate-limited", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(
      JSON.stringify({
        provider: "google",
        retryAt: new Date(Date.now() + 60_000).toISOString(),
        source: "test",
        detectedAt: new Date().toISOString(),
      }),
    );

    await expect(
      assertProviderNotRateLimited({
        emailAccountId: "account-1",
        provider: "google",
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitModeError);
  });

  it("does not throw when guard state lookup fails", async () => {
    vi.mocked(redis.get).mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(
      assertProviderNotRateLimited({
        emailAccountId: "account-1",
        provider: "google",
      }),
    ).resolves.toBeUndefined();
  });

  it("records rate-limit mode from gmail retry errors", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    const state = await recordProviderRateLimitFromError({
      emailAccountId: "account-1",
      provider: "google",
      error: {
        cause: {
          status: 429,
          message: `User-rate limit exceeded. Retry after ${retryAt}`,
        },
      },
      source: "test",
      logger,
    });

    expect(state).not.toBeNull();
    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );
  });

  it.each([
    [
      "a sending limit",
      `User-rate limit exceeded.  Retry after ${new Date(Date.now() + 3 * 60 * 60_000).toISOString()} (Mail sending)`,
    ],
    [
      "a retry time hours away",
      `User-rate limit exceeded. Retry after ${new Date(Date.now() + 2 * 60 * 60_000).toISOString()}`,
    ],
    ["too many concurrent requests", "Too many concurrent requests for user"],
  ])("never puts the account in rate-limit mode for %s", async (_, message) => {
    const state = await recordProviderRateLimitFromError({
      emailAccountId: "account-1",
      provider: "google",
      error: {
        cause: {
          status: 429,
          message,
          errors: [{ reason: "rateLimitExceeded" }],
        },
      },
      source: "test",
      logger,
    });

    expect(state).toBeNull();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("holds rate-limit mode for at most two minutes", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    const retryAt = new Date(Date.now() + 4 * 60_000).toISOString();

    const state = await recordProviderRateLimitFromError({
      emailAccountId: "account-1",
      provider: "google",
      error: {
        cause: {
          status: 429,
          message: `User-rate limit exceeded. Retry after ${retryAt}`,
        },
      },
      source: "test",
      logger,
    });

    expect(state!.retryAt.getTime() - Date.now()).toBeLessThanOrEqual(
      2 * 60_000,
    );
  });

  it("records and rethrows from wrapped operations", async () => {
    const retryAt = new Date(Date.now() + 120_000).toISOString();
    const rateLimitError = {
      cause: {
        status: 429,
        message: `User-rate limit exceeded. Retry after ${retryAt}`,
      },
    };
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    await expect(
      withRateLimitRecording(
        {
          emailAccountId: "account-1",
          provider: "google",
          source: "test-wrapper",
          logger,
        },
        async () => {
          throw rateLimitError;
        },
      ),
    ).rejects.toBe(rateLimitError);

    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );
  });

  it("rethrows original error when recording state fails", async () => {
    const rateLimitError = {
      cause: {
        status: 429,
        message: "Rate limit exceeded",
      },
    };
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    vi.mocked(redis.set).mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(
      withRateLimitRecording(
        {
          emailAccountId: "account-1",
          provider: "google",
          source: "test-wrapper",
          logger,
        },
        async () => {
          throw rateLimitError;
        },
      ),
    ).rejects.toBe(rateLimitError);
  });

  it("keeps existing longer retry window even when source differs", async () => {
    const existingRetryAt = new Date(Date.now() + 120_000);
    vi.mocked(redis.get).mockResolvedValueOnce(
      JSON.stringify({
        provider: "google",
        retryAt: existingRetryAt.toISOString(),
        source: "long-window",
        detectedAt: new Date().toISOString(),
      }),
    );

    const state = await setEmailProviderRateLimitState({
      emailAccountId: "account-1",
      provider: "google",
      retryAt: new Date(Date.now() + 30_000),
      source: "short-window",
      logger,
    });

    expect(state.retryAt.toISOString()).toBe(existingRetryAt.toISOString());
    expect(state.source).toBe("long-window");
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("records rate-limit mode for microsoft provider errors", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    const state = await recordProviderRateLimitFromError({
      emailAccountId: "account-1",
      provider: "microsoft",
      error: {
        statusCode: 429,
        code: "TooManyRequests",
        response: {
          headers: {
            "retry-after": "45",
          },
        },
      },
      source: "test-outlook",
      logger,
    });

    expect(state).not.toBeNull();
    expect(state?.provider).toBe("microsoft");
    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );
  });

  it("records rate-limit state from mapped API error type", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(null);

    const provider = await recordRateLimitFromApiError({
      apiErrorType: "Outlook Rate Limit",
      emailAccountId: "account-1",
      error: {
        statusCode: 429,
        code: "TooManyRequests",
      },
      source: "test-outlook-api-error",
      logger,
    });

    expect(provider).toBe("microsoft");
    expect(redis.set).toHaveBeenCalledWith(
      "email-provider-rate-limit:account-1",
      expect.any(String),
      expect.objectContaining({
        ex: expect.any(Number),
      }),
    );
  });

  it.each([
    "google",
    "microsoft",
  ] as const)("does not extend %s rate-limit mode when a call is skipped by the guard", async (provider) => {
    const error = new ProviderRateLimitModeError({
      provider,
      retryAt: new Date(Date.now() + 30_000),
    });

    await expect(
      recordProviderRateLimitFromError({
        error,
        emailAccountId: "account-1",
        provider,
        logger,
      }),
    ).resolves.toBeNull();
    await expect(
      withRateLimitRecording(
        { emailAccountId: "account-1", provider, logger },
        async () => {
          throw error;
        },
      ),
    ).rejects.toBe(error);

    expect(redis.set).not.toHaveBeenCalled();
  });

  it("does not throw when API-error rate-limit recording fails", async () => {
    vi.mocked(redis.get).mockResolvedValueOnce(null);
    vi.mocked(redis.set).mockRejectedValueOnce(new Error("redis unavailable"));

    await expect(
      recordRateLimitFromApiError({
        apiErrorType: "Gmail Rate Limit Exceeded",
        emailAccountId: "account-1",
        error: {
          cause: {
            status: 429,
            message: "Rate limit exceeded",
          },
        },
        source: "test-gmail-api-error",
        logger,
      }),
    ).resolves.toBe("google");
  });
});

describe("getProviderRateLimitDelayMs", () => {
  const perMinuteQuotaError = {
    cause: {
      status: 403,
      message:
        "Quota exceeded for quota metric 'Total Query Cost' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
      errors: [{ reason: "rateLimitExceeded" }],
    },
  };

  it("waits out Gmail's per-minute quota window when no retry time is given", () => {
    expect(
      getProviderRateLimitDelayMs({
        error: perMinuteQuotaError,
        provider: "google",
        attemptNumber: 1,
      }),
    ).toBeGreaterThanOrEqual(30_000);
  });

  it("uses Gmail's explicit retry time for per-minute quota errors", () => {
    const retryAt = new Date(Date.now() + 5000).toISOString();
    const delay = getProviderRateLimitDelayMs({
      error: {
        cause: {
          ...perMinuteQuotaError.cause,
          message: `${perMinuteQuotaError.cause.message}. Retry after ${retryAt}`,
        },
      },
      provider: "google",
      attemptNumber: 1,
    });
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(5000);
  });

  it("keeps short backoff for Gmail rate limits that are not per-minute quotas", () => {
    expect(
      getProviderRateLimitDelayMs({
        error: { cause: { status: 429, message: "Rate limit exceeded" } },
        provider: "google",
        attemptNumber: 1,
      }),
    ).toBeLessThan(30_000);
  });
});
