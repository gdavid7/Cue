import type { Prisma } from "@/generated/prisma/client";
import { getGoogleOauthRevokeUrl } from "@/utils/gmail/oauth";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

type GoogleGrant = Awaited<ReturnType<typeof getGoogleGrants>>[number];

/**
 * Reads the tokens of the Google accounts a deletion is about to remove, so
 * they can be revoked once it commits. Never throws: a read failure only
 * leaves the grants in place.
 */
export async function getGoogleGrants({
  where,
  logger,
}: {
  where: Prisma.AccountWhereInput;
  logger: Logger;
}) {
  try {
    const accounts = await prisma.account.findMany({
      where: { ...where, provider: "google", disconnectedAt: null },
      select: {
        id: true,
        refresh_token: true,
        access_token: true,
        emailAccount: { select: { id: true, email: true } },
      },
    });

    return accounts.flatMap((account) => {
      // Revoking a refresh token also revokes its access tokens.
      const token = account.refresh_token ?? account.access_token;
      if (!token) return [];
      return [
        {
          accountId: account.id,
          emailAccountId: account.emailAccount?.id ?? null,
          email: account.emailAccount?.email ?? null,
          token,
        },
      ];
    });
  } catch (error) {
    logger.warn("Could not read Google grants to revoke", {
      errorName: error instanceof Error ? error.name : undefined,
    });
    return [];
  }
}

/**
 * Takes the app off the person's Google third-party access. Call it only
 * after the deletion has committed, because a revoke cannot be undone.
 *
 * Google keeps one grant per Google account for our OAuth client, and
 * revoking any of its tokens ends all of them. Calendar and Drive connections
 * reuse that grant, so it is kept while one that is still stored uses the same
 * Google account. Best effort: never throws.
 *
 * Microsoft has no equivalent: its identity platform has no revocation
 * endpoint, and Graph's options are tenant-wide or admin-only.
 */
export async function revokeGoogleGrants({
  grants,
  logger,
}: {
  grants: GoogleGrant[];
  logger: Logger;
}) {
  await Promise.all(
    grants.map(async ({ accountId, emailAccountId, email, token }) => {
      const context = { accountId, emailAccountId };
      try {
        if (email && (await isGrantStillUsed(email))) {
          logger.info("Kept Google grant used by a connection", context);
          return;
        }

        const response = await fetch(getGoogleOauthRevokeUrl(), {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          logger.warn("Google grant revoke failed", {
            ...context,
            status: response.status,
          });
          return;
        }

        logger.info("Revoked Google grant", context);
      } catch (error) {
        logger.warn("Google grant revoke failed", {
          ...context,
          errorName: error instanceof Error ? error.name : undefined,
        });
      }
    }),
  );
}

async function isGrantStillUsed(email: string) {
  const where = {
    provider: "google",
    isConnected: true,
    email: { equals: email, mode: "insensitive" as const },
  };
  const [calendars, drives] = await Promise.all([
    prisma.calendarConnection.count({ where }),
    prisma.driveConnection.count({ where }),
  ]);
  return calendars + drives > 0;
}
