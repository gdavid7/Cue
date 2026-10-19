import "server-only";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

// "1" says the account is the user's. Ids only: the address never sits in
// Redis (RD-3). Removal and merges delete it; the expiry bounds a missed path.
const OWNER_TTL_SECONDS = 60 * 60;

/**
 * The address of the account when it belongs to the user, otherwise null.
 * One primary-key read: the address is needed, and it is never cached.
 */
export async function getEmailAccount({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<string | null> {
  if (!userId || !emailAccountId) return null;

  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
    select: { email: true },
  });
  return emailAccount?.email ?? null;
}

/** Whether the account is the user's, from Redis when it has said so lately. */
export async function isAccountOwner({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}): Promise<boolean> {
  if (!userId || !emailAccountId) return false;
  const cached = await redis
    .get(getOwnerKey({ userId, emailAccountId }))
    .catch(() => null);
  if (cached != null) return true;
  return confirmOwnership({ userId, emailAccountId });
}

/**
 * Reads one key per account for the accounts the user owns, in the same
 * command as the ownership check, so a frequent poll costs one Redis read.
 * Unowned accounts are left out. Ownership not cached yet is read from the
 * database and remembered.
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
      getOwnerKey({ userId, emailAccountId }),
    ),
    ...emailAccountIds.map(keyFor),
  );
  const owned = await Promise.all(
    emailAccountIds.map(
      async (emailAccountId, index) =>
        values[index] != null ||
        (await confirmOwnership({ userId, emailAccountId })),
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

/** Forgets that the account is the user's, when it is removed or moved. */
export async function invalidateAccountOwnership({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}) {
  await redis
    .del(getOwnerKey({ userId, emailAccountId }))
    .catch(() => undefined);
}

async function confirmOwnership({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}) {
  const owned = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
    select: { id: true },
  });
  if (!owned) return false;
  await redis
    .set(getOwnerKey({ userId, emailAccountId }), "1", {
      ex: OWNER_TTL_SECONDS,
    })
    .catch(() => null);
  return true;
}

// Not `account:*`: keys under that prefix held addresses and the RD-3
// cleanup deletes them.
function getOwnerKey({
  userId,
  emailAccountId,
}: {
  userId: string;
  emailAccountId: string;
}) {
  return `account-owner:${userId}:${emailAccountId}`;
}
