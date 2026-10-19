import "server-only";
import prisma from "@/utils/prisma";

/**
 * The address of the account when it belongs to the user, otherwise null.
 * Asked of the database on every check: one primary-key read, and the
 * address never sits in Redis or instance memory (RD-3). A merge, transfer or
 * deletion therefore takes effect on the next request with nothing to
 * invalidate.
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
