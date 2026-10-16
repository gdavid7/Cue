import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import {
  getEmailProviderRateLimitStateFromRedis,
  setEmailProviderRateLimitStateInRedis,
} from "@/utils/redis/email-provider-rate-limit";

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(),
    del: vi.fn(),
    set: vi.fn(),
  },
}));

describe("email provider rate-limit redis state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads state automatically deserialized by the Redis client", async () => {
    const retryAt = new Date(Date.now() + 60_000);
    vi.mocked(redis.get).mockResolvedValue({
      provider: "google",
      retryAt: retryAt.toISOString(),
      source: "gmail-provider/get-messages",
      detectedAt: new Date().toISOString(),
    } as never);

    await expect(
      getEmailProviderRateLimitStateFromRedis({
        emailAccountId: "email-account-1",
      }),
    ).resolves.toEqual({
      provider: "google",
      retryAt,
      source: "gmail-provider/get-messages",
    });
    expect(redis.del).not.toHaveBeenCalled();
  });

  // Every provider created for a request checks this; an instance reads it
  // at most once every few seconds per account.
  it("reads an account's state once per instance within a few seconds", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);

    await getEmailProviderRateLimitStateFromRedis({ emailAccountId: "memo-1" });
    await getEmailProviderRateLimitStateFromRedis({ emailAccountId: "memo-1" });

    expect(redis.get).toHaveBeenCalledOnce();
  });

  it("sees state this instance just set without waiting", async () => {
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue("OK");
    await getEmailProviderRateLimitStateFromRedis({ emailAccountId: "memo-2" });
    const retryAt = new Date(Date.now() + 60_000);

    await setEmailProviderRateLimitStateInRedis({
      emailAccountId: "memo-2",
      provider: "google",
      retryAt,
      ttlSeconds: 65,
    });

    await expect(
      getEmailProviderRateLimitStateFromRedis({ emailAccountId: "memo-2" }),
    ).resolves.toMatchObject({ provider: "google", retryAt });
    expect(redis.get).toHaveBeenCalledOnce();
  });
});
