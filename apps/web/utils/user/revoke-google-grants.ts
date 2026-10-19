import { getGoogleOauthRevokeUrl } from "@/utils/gmail/oauth";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Takes the app off the person's Google third-party access when they delete
 * their account or remove a Google mailbox. Call it after the mailbox's watch
 * is stopped (that needs the grant) and before its token rows are deleted.
 *
 * Google keeps one grant per Google account for our OAuth client, and revoking
 * any of its tokens ends all of them. Calendar and Drive connections reuse that
 * grant, so it is kept while a connection that outlives the removal still uses
 * the same Google account.
 *
 * Best effort: never throws, so a revoke failure cannot block the deletion.
 *
 * Microsoft has no equivalent: its identity platform has no token revocation
 * endpoint, and Graph's options either sign the person out of every app
 * (revokeSignInSessions) or need admin-consented directory permissions and do
 * not exist for personal accounts (deleting the oauth2PermissionGrant). Its
 * refresh tokens are unusable once deleted here, and people remove the consent
 * from their Microsoft account's app permissions.
 */
export async function revokeGoogleGrants({
  emailAccountIds,
  keepsConnections,
  logger,
}: {
  emailAccountIds: string[];
  // True when the removed mailboxes' Calendar and Drive connections move to a
  // remaining mailbox instead of being deleted with them.
  keepsConnections: boolean;
  logger: Logger;
}) {
  try {
    const accounts = await prisma.account.findMany({
      where: {
        provider: "google",
        disconnectedAt: null,
        emailAccount: { id: { in: emailAccountIds } },
      },
      select: {
        id: true,
        refresh_token: true,
        access_token: true,
        emailAccount: { select: { id: true, email: true } },
      },
    });

    await Promise.all(
      accounts.map(async (account) => {
        const emailAccount = account.emailAccount;
        // Revoking a refresh token also revokes its access tokens.
        const token = account.refresh_token ?? account.access_token;
        if (!emailAccount || !token) return;

        const context = {
          emailAccountId: emailAccount.id,
          accountId: account.id,
        };

        try {
          const shared = await isGrantStillUsed({
            email: emailAccount.email,
            removedEmailAccountIds: keepsConnections ? [] : emailAccountIds,
          });
          if (shared) {
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
  } catch (error) {
    logger.warn("Google grant revoke failed", {
      emailAccountIds,
      errorName: error instanceof Error ? error.name : undefined,
    });
  }
}

async function isGrantStillUsed({
  email,
  removedEmailAccountIds,
}: {
  email: string;
  removedEmailAccountIds: string[];
}) {
  const where = {
    provider: "google",
    isConnected: true,
    email: { equals: email, mode: "insensitive" as const },
    emailAccountId: { notIn: removedEmailAccountIds },
  };
  const [calendars, drives] = await Promise.all([
    prisma.calendarConnection.count({ where }),
    prisma.driveConnection.count({ where }),
  ]);
  return calendars + drives > 0;
}
