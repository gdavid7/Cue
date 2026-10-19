import "server-only";
import prisma from "@/utils/prisma";
import { canonicalizeEmailAddress } from "@/utils/email";

/**
 * Every address the user has connected, lowercased. Mail between them is the
 * user writing to themselves, never someone else. Gmail send-as aliases are
 * not stored, so the Gmail provider adds those itself where it reads them.
 * Read from the database each time: addresses stay out of server caches.
 */
export async function getUserOwnAddresses(userId: string): Promise<string[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { email: true },
  });
  return [
    ...new Set(
      accounts
        .map((account) => canonicalizeEmailAddress(account.email))
        .filter(Boolean),
    ),
  ];
}

export function isOwnAddress(header: string, ownAddresses: string[]) {
  const address = canonicalizeEmailAddress(header);
  return Boolean(address) && ownAddresses.includes(address);
}
