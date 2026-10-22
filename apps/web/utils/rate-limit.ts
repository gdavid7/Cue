import "server-only";
import { createHmac } from "node:crypto";
import { env } from "@/env";
import { SafeError } from "@/utils/error";
import { redis } from "@/utils/redis";
import type { Logger } from "@/utils/logger";

type RateLimitRule = {
  key: string;
  limit: number;
  windowSeconds: number;
};

type RateLimitResult =
  | {
      limited: false;
      limit: number;
      remaining: number;
    }
  | {
      limited: true;
      limit: number;
      retryAfterSeconds: number;
    };

export async function checkRateLimit({
  rule,
  cost,
  logger,
}: {
  rule: RateLimitRule;
  /** Units this request uses, for a limit counted in units; one by default. */
  cost?: number;
  logger?: Logger;
}): Promise<RateLimitResult> {
  if (!isRedisRateLimitConfigured()) {
    return {
      limited: false,
      limit: rule.limit,
      remaining: rule.limit,
    };
  }

  try {
    const count = Number(
      await redis.eval<string[], number>(
        INCREMENT_RATE_LIMIT_SCRIPT,
        [rule.key],
        cost === undefined
          ? [rule.windowSeconds.toString()]
          : [rule.windowSeconds.toString(), cost.toString()],
      ),
    );

    if (count > rule.limit) {
      return {
        limited: true,
        limit: rule.limit,
        retryAfterSeconds: rule.windowSeconds,
      };
    }

    return {
      limited: false,
      limit: rule.limit,
      remaining: Math.max(rule.limit - count, 0),
    };
  } catch (error) {
    logger?.warn("Redis rate limit unavailable", {
      error: error instanceof Error ? error.message : error,
    });

    return {
      limited: false,
      limit: rule.limit,
      remaining: rule.limit,
    };
  }
}

/**
 * Caps how often one user can run a costly request, failing with the 429
 * known error the clients already show as a message.
 */
export async function assertWithinUserRateLimit({
  scope,
  userId,
  limit,
  windowSeconds,
  cost,
  logger,
}: {
  scope: string;
  userId: string;
  limit: number;
  windowSeconds: number;
  /** Units this request uses, for a limit counted in units; one by default. */
  cost?: number;
  logger?: Logger;
}) {
  const result = await checkRateLimit({
    rule: {
      key: createRateLimitKey(["rate-limit", scope, userId]),
      limit,
      windowSeconds,
    },
    cost,
    logger,
  });
  if (result.limited) {
    throw new SafeError(
      "Cue needs a short break. Try again in a few minutes.",
      429,
    );
  }
}

export function createRateLimitKey(parts: string[]) {
  return parts.map((part) => hashKeyPart(part)).join(":");
}

// Assumes the deployment sits behind a trusted platform or load balancer that
// appends the real client IP to the trusted edge of the chain, so we read the
// rightmost `x-forwarded-for` entry. Leftmost values, provider-specific
// visitor IP headers, and `x-real-ip` can be client-controlled when the origin
// is directly reachable and are unsafe to trust for rate limiting.
export function getClientIp(headers: Headers) {
  const forwardedFor = headers.get("x-forwarded-for");
  if (forwardedFor) {
    const entries = forwardedFor.split(",");
    const rightmost = entries.at(-1)?.trim();
    if (rightmost) return rightmost;
  }

  return "unknown";
}

export function hashRateLimitValue(value: string) {
  return createHmac("sha256", getRateLimitHashSecret())
    .update(value)
    .digest("hex");
}

function hashKeyPart(part: string) {
  return part.replaceAll(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
}

function isRedisRateLimitConfigured() {
  return (
    env.NODE_ENV === "test" ||
    Boolean(env.REDIS_HTTP_URL && env.REDIS_HTTP_TOKEN)
  );
}

function getRateLimitHashSecret() {
  const secret =
    env.AUTH_SECRET || env.NEXTAUTH_SECRET || env.EMAIL_ENCRYPT_SECRET;
  if (!secret) {
    throw new Error("Rate limit hash secret missing: set AUTH_SECRET");
  }
  return secret;
}

// The window starts with the first increment, whatever its cost.
const INCREMENT_RATE_LIMIT_SCRIPT = `
local cost = tonumber(ARGV[2] or "1")
local count = redis.call("INCRBY", KEYS[1], cost)
if count == cost then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`.trim();
