import "server-only";
import { env } from "@/env";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { createMemoCache } from "@/utils/memo-cache";
import { getSharedSubscriber } from "@/utils/redis/shared-subscriber";

const EXPIRATION = 60 * 60; // 1 hour
const INVALIDATION_CHANNEL = "account-validation:invalidate";

type Listen = (
  channel: string,
  listener: { onMessage: (message: string) => void; onLost: () => void },
) => { ready: Promise<unknown> };

/**
 * Most authenticated requests check the account, so each instance trusts an
 * owned account for 15 seconds. An invalidation (a merge, transfer or
 * deletion) is published to every instance, which drops it at once; the TTL
 * bounds staleness when that message is missed, and an instance whose
 * subscription dropped forgets everything.
 */
export function createOwnedAccountMemo({
  listen,
  publish,
}: {
  listen: Listen;
  publish: (channel: string, message: string) => Promise<unknown>;
}) {
  const memo = createMemoCache<string | null>({
    ttlMs: 15_000,
    maxEntries: 5000,
    keep: (email) => email !== null,
  });
  let listening = false;
  const listenForInvalidations = () => {
    if (listening) return;
    listening = true;
    try {
      listen(INVALIDATION_CHANNEL, {
        onMessage: (key) => memo.delete(key),
        onLost: () => memo.clear(),
      }).ready.catch(() => {
        listening = false;
      });
    } catch {
      listening = false;
    }
  };
  return {
    get(key: string, load: () => Promise<string | null>) {
      listenForInvalidations();
      return memo.get(key, load);
    },
    async invalidate(key: string) {
      memo.delete(key);
      await publish(INVALIDATION_CHANNEL, key);
    },
  };
}

const ownedAccounts = createOwnedAccountMemo({
  // Without a pub/sub connection the 15-second TTL is the bound.
  listen: (channel, listener) =>
    env.REDIS_URL
      ? getSharedSubscriber().listen(channel, listener)
      : { ready: Promise.resolve() },
  publish: (channel, message) => redis.publish(channel, message),
});

/**
 * Get the Redis key for account validation
 */
function getValidationKey({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): string {
  return `account:${userId}:${emailAccountId}`;
}

/**
 * Validate that an account belongs to a user, using Redis for caching
 * @param userId The user ID
 * @param accountId The account ID to validate
 * @returns email address of the account if it belongs to the user, otherwise null
 */
export async function getEmailAccount({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<string | null> {
  if (!userId || !emailAccountId) return null;

  const key = getValidationKey({ userId, emailAccountId });
  return ownedAccounts.get(key, () =>
    lookUpEmailAccount(key, emailAccountId, userId),
  );
}

async function lookUpEmailAccount(
  key: string,
  emailAccountId: string,
  userId: string,
): Promise<string | null> {
  // Check Redis cache first
  try {
    const cachedResult = await redis.get<string>(key);
    if (cachedResult !== null) {
      return cachedResult;
    }
  } catch {
    // Redis unavailable — fall through to database
  }

  // Not in cache, check database
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
    select: { email: true },
  });

  // Cache the result (best-effort)
  try {
    await redis.set(key, emailAccount?.email ?? null, { ex: EXPIRATION });
  } catch {
    // Redis unavailable — skip caching
  }

  return emailAccount?.email ?? null;
}

/**
 * Invalidate the cached validation result for a user's account
 * Useful when account ownership changes
 */
export async function invalidateAccountValidation({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<void> {
  const key = getValidationKey({ userId, emailAccountId });
  try {
    await redis.del(key);
  } catch {
    // Redis unavailable — skip invalidation
  }
  await ownedAccounts.invalidate(key).catch(() => {
    // Other instances drop it when their 15-second memo expires.
  });
}
