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
) => { ready: Promise<unknown>; close?: () => void };

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
      const subscription = listen(INVALIDATION_CHANNEL, {
        onMessage: (key) => memo.delete(key),
        // A dropped connection only reports to a subscription once, so this
        // one is closed and the next check subscribes afresh, to hear about
        // the next drop too.
        onLost: () => {
          memo.clear();
          subscription.close?.();
          listening = false;
        },
      });
      subscription.ready.catch(() => {
        subscription.close?.();
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

/**
 * Reads one key per account for the accounts the user owns, in the same
 * command as the ownership check, so a frequent poll costs one Redis read.
 * Unowned accounts are left out. Ownership not cached yet falls back to
 * `getEmailAccount`.
 */
export async function readKeyForOwnedAccounts({
  userId,
  emailAccountIds,
  keyFor,
}: {
  userId: string;
  emailAccountIds: string[];
  keyFor: (emailAccountId: string) => string;
}): Promise<Map<string, unknown>> {
  const values = await redis.mget<unknown[]>(
    ...emailAccountIds.map((emailAccountId) =>
      getValidationKey({ userId, emailAccountId }),
    ),
    ...emailAccountIds.map(keyFor),
  );
  const owned = await Promise.all(
    emailAccountIds.map(
      async (emailAccountId, index) =>
        values[index] != null ||
        (await getEmailAccount({ userId, emailAccountId })) !== null,
    ),
  );
  const result = new Map<string, unknown>();
  emailAccountIds.forEach((emailAccountId, index) => {
    if (owned[index])
      result.set(
        emailAccountId,
        values[emailAccountIds.length + index] ?? null,
      );
  });
  return result;
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
