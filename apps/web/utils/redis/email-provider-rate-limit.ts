import "server-only";
import { env } from "@/env";
import {
  type EmailProviderRateLimitProvider,
  toRateLimitProvider,
} from "@/utils/email/rate-limit-mode-error";
import { createMemoCache } from "@/utils/memo-cache";
import { redis } from "@/utils/redis";

const RATE_LIMIT_KEY_PREFIX = "email-provider-rate-limit";

// Read for every provider a request creates. An instance rereads an account
// at most every few seconds and sees its own writes at once; another
// instance's new state reaches it within that window, while the quota gate
// keeps pacing the calls in between.
const recentStates = createMemoCache<RedisEmailProviderRateLimitState | null>({
  ttlMs: 5000,
  maxEntries: 5000,
});

type StoredEmailProviderRateLimitState = {
  provider: EmailProviderRateLimitProvider;
  retryAt: string;
  source?: string;
  detectedAt: string;
};

export type RedisEmailProviderRateLimitState = {
  provider: EmailProviderRateLimitProvider;
  retryAt: Date;
  source?: string;
};

function getRateLimitKey(emailAccountId: string) {
  return `${RATE_LIMIT_KEY_PREFIX}:${emailAccountId}`;
}

export async function getEmailProviderRateLimitStateFromRedis({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  if (!isEmailProviderRateLimitRedisConfigured()) return null;

  const state = await recentStates.get(emailAccountId, () =>
    readRateLimitState(emailAccountId),
  );
  if (state && state.retryAt.getTime() <= Date.now()) return null;
  return state;
}

async function readRateLimitState(
  emailAccountId: string,
): Promise<RedisEmailProviderRateLimitState | null> {
  const key = getRateLimitKey(emailAccountId);
  const value = await redis.get<StoredEmailProviderRateLimitState | string>(
    key,
  );
  if (!value) return null;

  const parsed = parseStoredEmailProviderRateLimitState(value);
  if (!parsed) {
    await redis.del(key);
    return null;
  }

  const retryAt = new Date(parsed.retryAt);
  if (retryAt.getTime() <= Date.now()) {
    await redis.del(key);
    return null;
  }

  return {
    provider: parsed.provider,
    retryAt,
    source: parsed.source,
  } satisfies RedisEmailProviderRateLimitState;
}

export async function setEmailProviderRateLimitStateInRedis({
  emailAccountId,
  provider,
  retryAt,
  source,
  ttlSeconds,
}: {
  emailAccountId: string;
  provider: EmailProviderRateLimitProvider;
  retryAt: Date;
  source?: string;
  ttlSeconds: number;
}) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;
  const value: StoredEmailProviderRateLimitState = {
    provider,
    retryAt: retryAt.toISOString(),
    source,
    detectedAt: new Date().toISOString(),
  };
  await redis.set(getRateLimitKey(emailAccountId), JSON.stringify(value), {
    ex: ttlSeconds,
  });
  recentStates.set(emailAccountId, { provider, retryAt, source });
}

export async function deleteEmailProviderRateLimitStateFromRedis({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;
  await redis.del(getRateLimitKey(emailAccountId));
  recentStates.delete(emailAccountId);
}

export function isEmailProviderRateLimitRedisConfigured() {
  return (
    env.NODE_ENV === "test" ||
    Boolean(env.REDIS_HTTP_URL && env.REDIS_HTTP_TOKEN)
  );
}

function parseStoredEmailProviderRateLimitState(
  value: StoredEmailProviderRateLimitState | string,
): StoredEmailProviderRateLimitState | null {
  try {
    const parsed =
      typeof value === "string"
        ? (JSON.parse(value) as Partial<StoredEmailProviderRateLimitState>)
        : value;
    const provider = toRateLimitProvider(parsed.provider);
    if (!provider) return null;
    if (!parsed.retryAt || typeof parsed.retryAt !== "string") return null;
    if (Number.isNaN(new Date(parsed.retryAt).getTime())) return null;

    return {
      provider,
      retryAt: parsed.retryAt,
      source: typeof parsed.source === "string" ? parsed.source : undefined,
      detectedAt: parsed.detectedAt || new Date().toISOString(),
    };
  } catch {
    return null;
  }
}
