import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockedEnv } = vi.hoisted(() => ({
  mockedEnv: {
    NODE_ENV: "production",
    REDIS_HTTP_URL: "https://redis.example.com",
    REDIS_HTTP_TOKEN: "token",
    AUTH_SECRET: "test-auth-secret",
    NEXTAUTH_SECRET: undefined as string | undefined,
    EMAIL_ENCRYPT_SECRET: "test-email-encrypt-secret",
  },
}));

vi.mock("@/env", () => ({
  env: mockedEnv,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({
  redis: {
    eval: vi.fn(),
  },
}));

import { redis } from "@/utils/redis";
import {
  assertWithinUserRateLimit,
  checkRateLimit,
  createRateLimitKey,
  getClientIp,
} from "@/utils/rate-limit";

describe("rate limit utilities", () => {
  beforeEach(() => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.REDIS_HTTP_URL = "https://redis.example.com";
    mockedEnv.REDIS_HTTP_TOKEN = "token";
    vi.clearAllMocks();
  });

  it("allows requests while the counter is under the limit", async () => {
    vi.mocked(redis.eval).mockResolvedValue(2);

    const result = await checkRateLimit({
      rule: {
        key: "rate-limit:test",
        limit: 3,
        windowSeconds: 60,
      },
    });

    expect(result).toEqual({
      limited: false,
      limit: 3,
      remaining: 1,
    });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:test"],
      ["60"],
    );
  });

  it("increments and expires a counter window atomically", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    await checkRateLimit({
      rule: {
        key: "rate-limit:test",
        limit: 3,
        windowSeconds: 60,
      },
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("EXPIRE", KEYS[1]'),
      ["rate-limit:test"],
      ["60"],
    );
  });

  it("blocks requests over the limit", async () => {
    vi.mocked(redis.eval).mockResolvedValue(4);

    const result = await checkRateLimit({
      rule: {
        key: "rate-limit:test",
        limit: 3,
        windowSeconds: 60,
      },
    });

    expect(result).toEqual({
      limited: true,
      limit: 3,
      retryAfterSeconds: 60,
    });
  });

  // A request that does many units of work is charged for each, so a limit
  // can be set in units rather than requests.
  it("charges a request's cost against the limit in one increment", async () => {
    vi.mocked(redis.eval).mockResolvedValue(30);

    const result = await checkRateLimit({
      rule: { key: "rate-limit:test", limit: 40, windowSeconds: 60 },
      cost: 10,
    });

    expect(result).toEqual({ limited: false, limit: 40, remaining: 10 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("INCRBY", KEYS[1]'),
      ["rate-limit:test"],
      ["60", "10"],
    );
  });

  it("fails open when Redis is unavailable", async () => {
    vi.mocked(redis.eval).mockRejectedValue(new Error("redis down"));

    const result = await checkRateLimit({
      rule: {
        key: "rate-limit:test",
        limit: 3,
        windowSeconds: 60,
      },
    });

    expect(result).toEqual({
      limited: false,
      limit: 3,
      remaining: 3,
    });
  });

  it("disables Redis calls when Redis is not configured", async () => {
    mockedEnv.REDIS_HTTP_URL = undefined;
    mockedEnv.REDIS_HTTP_TOKEN = undefined;

    const result = await checkRateLimit({
      rule: {
        key: "rate-limit:test",
        limit: 3,
        windowSeconds: 60,
      },
    });

    expect(result.limited).toBe(false);
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("builds safe key strings", () => {
    expect(createRateLimitKey(["rate limit", "book/link", "a:b"])).toBe(
      "rate_limit:book_link:a_b",
    );
  });

  it.each([
    {
      name: "rightmost forwarded IP",
      headers: {
        "x-forwarded-for": "203.0.113.1, 10.0.0.1",
      },
      expected: "10.0.0.1",
    },
    {
      name: "rightmost forwarded IP over provider visitor IP",
      headers: {
        "cf-connecting-ip": "198.51.100.7",
        "x-forwarded-for": "203.0.113.1, 10.0.0.1",
      },
      expected: "10.0.0.1",
    },
    {
      name: "unknown when only provider visitor IP is present",
      headers: {
        "cf-connecting-ip": "198.51.100.7",
      },
      expected: "unknown",
    },
    {
      name: "unknown when only x-real-ip is present",
      headers: {
        "x-real-ip": "203.0.113.99",
      },
      expected: "unknown",
    },
  ])("extracts $name", ({ headers, expected }) => {
    expect(getClientIp(new Headers(headers))).toBe(expected);
  });
});

describe("assertWithinUserRateLimit", () => {
  beforeEach(() => {
    mockedEnv.NODE_ENV = "production";
    mockedEnv.REDIS_HTTP_URL = "https://redis.example.com";
    mockedEnv.REDIS_HTTP_TOKEN = "token";
    vi.clearAllMocks();
  });

  it("counts each user separately for a scope", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    await assertWithinUserRateLimit({
      scope: "search-answer",
      userId: "user-1",
      limit: 60,
      windowSeconds: 300,
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:search-answer:user-1"],
      ["300"],
    );
  });

  it("charges the user's scope for a request's cost", async () => {
    vi.mocked(redis.eval).mockResolvedValue(755);

    await expect(
      assertWithinUserRateLimit({
        scope: "inbox-insights",
        userId: "user-1",
        limit: 750,
        windowSeconds: 300,
        cost: 10,
      }),
    ).rejects.toMatchObject({ statusCode: 429 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      ["rate-limit:inbox-insights:user-1"],
      ["300", "10"],
    );
  });

  it("rejects with a 429 known error once the user is over the limit", async () => {
    vi.mocked(redis.eval).mockResolvedValue(61);

    await expect(
      assertWithinUserRateLimit({
        scope: "search-answer",
        userId: "user-1",
        limit: 60,
        windowSeconds: 300,
      }),
    ).rejects.toMatchObject({
      name: "SafeError",
      statusCode: 429,
      safeMessage: expect.stringContaining("Try again in a few minutes"),
    });
  });
});
