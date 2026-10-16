import "server-only";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { canonicalizeEmailAddress } from "@/utils/email";

// Linking and removal invalidate the key; the expiry only bounds a missed path.
const EXPIRATION_SECONDS = 10 * 60;

/**
 * Every address the user has connected, lowercased. Mail between them is the
 * user writing to themselves, never someone else. Gmail send-as aliases are
 * not stored, so the Gmail provider adds those itself where it reads them.
 */
export async function getUserOwnAddresses(userId: string): Promise<string[]> {
  const key = getKey(userId);
  const cached = await redis.get<string[]>(key).catch(() => null);
  if (cached) return cached;

  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { email: true },
  });
  const addresses = [
    ...new Set(
      accounts
        .map((account) => canonicalizeEmailAddress(account.email))
        .filter(Boolean),
    ),
  ];

  await redis
    .set(key, addresses, { ex: EXPIRATION_SECONDS })
    .catch(() => undefined);
  return addresses;
}

export async function invalidateUserOwnAddresses(userId: string) {
  await redis.del(getKey(userId)).catch(() => undefined);
}

export function isOwnAddress(header: string, ownAddresses: string[]) {
  const address = canonicalizeEmailAddress(header);
  return Boolean(address) && ownAddresses.includes(address);
}

function getKey(userId: string) {
  return `own-addresses:${userId}`;
}
