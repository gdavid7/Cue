import prisma from "@/utils/prisma";
import {
  getPremiumUserFilter,
  getUserTier,
  hasAiAccess,
  premiumEntitlementSelect,
} from "@/utils/premium";
import type { Logger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { captureException, isInvalidGrantError } from "@/utils/error";
import { cleanupInvalidTokens } from "@/utils/auth/cleanup-invalid-tokens";
import type { EmailProvider } from "@/utils/email/types";
import { createManagedOutlookSubscription } from "@/utils/outlook/subscription-manager";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { logErrorWithDedupe } from "@/utils/log-error-with-dedupe";
import { clearWatchLapsedErrorIfResolved } from "@/utils/error-messages";
import { syncGoogleEmailFromProfile } from "@/utils/auth/rename-email";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { hasTimeBeforeRequestDeadline } from "@/utils/request-deadline-reader";

export const WATCH_RESUME_PATH = "/api/watch/resume";
// Room for the account in progress to finish before the request is killed.
const ACCOUNT_RESERVE_MS = 30_000;

export type WatchEmailAccountResult =
  | {
      emailAccountId: string;
      status: "success";
      expirationDate: Date;
    }
  | {
      emailAccountId: string;
      status: "error";
      message: string;
      errorDetails?: string;
    };

export async function ensureEmailAccountsWatched({
  userIds,
  emailAccountId,
  deferrals = 0,
  logger,
}: {
  userIds: string[] | null;
  /** Watches only this mailbox, as when resuming its deferred watch. */
  emailAccountId?: string;
  /** How many times the Gmail quota gate has deferred this watch. */
  deferrals?: number;
  logger: Logger;
}): Promise<WatchEmailAccountResult[]> {
  const emailAccounts = await getEmailAccountsToWatch(userIds, emailAccountId);
  return await watchEmailAccounts(emailAccounts, deferrals, logger);
}

async function getEmailAccountsToWatch(
  userIds: string[] | null,
  emailAccountId: string | undefined,
) {
  return prisma.emailAccount.findMany({
    where: {
      ...(userIds ? { userId: { in: userIds } } : {}),
      ...(emailAccountId !== undefined ? { id: emailAccountId } : {}),
      ...getPremiumUserFilter(),
      account: { disconnectedAt: null },
    },
    select: {
      id: true,
      email: true,
      watchEmailsExpirationDate: true,
      watchEmailsSubscriptionId: true,
      userId: true,
      accountId: true,
      account: {
        select: {
          provider: true,
          providerAccountId: true,
          access_token: true,
          refresh_token: true,
          expires_at: true,
          disconnectedAt: true,
        },
      },
      user: {
        select: {
          id: true,
          email: true,
          aiApiKey: true,
          premium: {
            select: premiumEntitlementSelect,
          },
        },
      },
    },
    orderBy: {
      watchEmailsExpirationDate: { sort: "asc", nulls: "first" },
    },
  });
}

async function watchEmailAccounts(
  emailAccounts: Awaited<ReturnType<typeof getEmailAccountsToWatch>>,
  deferrals: number,
  logger: Logger,
): Promise<WatchEmailAccountResult[]> {
  if (!emailAccounts.length) return [];

  logger.info("Watching email accounts", { count: emailAccounts.length });

  const results: WatchEmailAccountResult[] = [];

  for (const [index, emailAccount] of emailAccounts.entries()) {
    // Soonest-expiring go first, so the ones left can wait for the next run.
    if (!hasTimeBeforeRequestDeadline(ACCOUNT_RESERVE_MS)) {
      logger.warn("Stopping email watch renewal before the deadline", {
        accountsLeft: emailAccounts.length - index,
      });
      break;
    }
    try {
      const log = logger.with({
        emailAccountId: emailAccount.id,
        email: emailAccount.email,
        provider: emailAccount.account.provider,
      });
      const result = await watchEmailAccount(emailAccount, deferrals, log);
      if (result) results.push(result);
    } catch (error) {
      if (error instanceof Error) {
        const warn = [
          "Mail service not enabled",
          "Insufficient Permission",
          "AADSTS7000215", // Raw Azure AD error for invalid client secret (old tokens after secret rotation)
        ];

        if (
          isInvalidGrantError(error) ||
          warn.some((w) => error.message.includes(w))
        ) {
          logger.warn("Not watching emails for user", {
            email: emailAccount.email,
            error,
          });
          continue;
        }
      }

      logger.error("Error for user", { error });
      results.push({
        emailAccountId: emailAccount.id,
        status: "error",
        message:
          "An unexpected error occurred while setting up watch for this account.",
        errorDetails: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
}

async function watchEmailAccount(
  emailAccount: Awaited<ReturnType<typeof getEmailAccountsToWatch>>[number],
  deferrals: number,
  logger: Logger,
): Promise<WatchEmailAccountResult | null> {
  const { account, user, watchEmailsExpirationDate } = emailAccount;

  const userHasAiAccess = hasAiAccess(
    getUserTier(user.premium),
    !!user.aiApiKey,
  );

  if (!userHasAiAccess) {
    logger.info("User does not have access to AI or cold email");

    if (
      watchEmailsExpirationDate &&
      new Date(watchEmailsExpirationDate) < new Date()
    ) {
      await prisma.emailAccount.updateMany({
        where: { id: emailAccount.id },
        data: {
          watchEmailsExpirationDate: null,
          watchEmailsSubscriptionId: null,
        },
      });
    }

    return null;
  }

  if (!account?.access_token || !account?.refresh_token) {
    logger.info("User has no access token or refresh token");

    return {
      emailAccountId: emailAccount.id,
      status: "error",
      message: "Missing authentication tokens.",
    };
  }

  logger.info("Watching emails for account");

  const provider = await createEmailProvider({
    emailAccountId: emailAccount.id,
    provider: account.provider,
    logger,
  });

  const result = await watchEmails({
    emailAccountId: emailAccount.id,
    provider,
    logger,
  });

  if (!result.success) {
    // Without push the mailbox gets no new mail until the next renewal, so a
    // watch the quota gate put off is tried again as soon as it allows.
    const resume = await resumeAfterGmailDeferral({
      error: result.error,
      path: WATCH_RESUME_PATH,
      body: { emailAccountId: emailAccount.id },
      deferrals,
      jobKey: `gmail-watch-${emailAccount.id}-${Math.floor(Date.now() / 60_000)}`,
      job: "Gmail watch setup",
      logger,
    });
    if (resume !== "scheduled")
      await logErrorWithDedupe({
        logger,
        message: "Failed to watch emails for account",
        error: result.error,
        dedupeKeyParts: {
          scope: "watch/all",
          emailAccountId: emailAccount.id,
          operation: "watch-email-account",
        },
        ttlSeconds: 15 * 60,
        summaryIntervalSeconds: 5 * 60,
      });

    return {
      emailAccountId: emailAccount.id,
      status: "error",
      message: "Failed to set up watch for this account.",
      errorDetails:
        result.error instanceof Error
          ? result.error.message
          : String(result.error),
    };
  }

  if (
    isGoogleProvider(account.provider) &&
    isEmailSyncDue(emailAccount.id, new Date())
  ) {
    try {
      const renamed = await syncGoogleEmailFromProfile({
        account: {
          id: emailAccount.accountId,
          userId: emailAccount.userId,
          providerId: account.provider,
          accountId: account.providerAccountId,
        },
        mailbox: { id: emailAccount.id, email: emailAccount.email },
        userEmail: user.email,
        accessToken: provider.getAccessToken(),
      });
      if (renamed) logger.info("Synced renamed Google mailbox address");
    } catch (error) {
      logger.warn("Failed to sync Google mailbox address", { error });
    }
  }

  const wasLapsed =
    !watchEmailsExpirationDate ||
    new Date(watchEmailsExpirationDate) < new Date();

  if (wasLapsed) {
    // The watch is healthy again, so clear the lapse error. This lets us
    // notify again if the account lapses in the future.
    await clearWatchLapsedErrorIfResolved({
      userId: user.id,
      emailAccountId: emailAccount.id,
      logger,
    });
  }

  return {
    emailAccountId: emailAccount.id,
    status: "success",
    expirationDate: result.expirationDate,
  };
}

async function watchEmails({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
}): Promise<
  { success: true; expirationDate: Date } | { success: false; error: unknown }
> {
  logger.info("Watching emails");
  let failedAccessToken: string | undefined;

  try {
    try {
      failedAccessToken = provider.getAccessToken();
    } catch {
      // The watch request may still refresh a missing cached access token.
    }
    if (isMicrosoftProvider(provider.name)) {
      const result = await createManagedOutlookSubscription({
        emailAccountId,
        logger,
      });

      if (result)
        return { success: true, expirationDate: result.expirationDate };
    } else {
      const result = await provider.watchEmails();

      if (result) {
        // A mailbox's first push reads history from its cursor; without one
        // it would read from 0, which Gmail reports as expired, and the mail
        // that sent the push would be skipped. An existing cursor is left
        // alone so a renewal never moves past unprocessed history. It is
        // saved before the expiry, which marks the watch healthy: a failure
        // here leaves the watch to be set up, and the cursor saved, again.
        if (result.historyId) {
          await prisma.emailAccount.updateMany({
            where: { id: emailAccountId, lastSyncedHistoryId: null },
            data: { lastSyncedHistoryId: result.historyId },
          });
        }
        await prisma.emailAccount.update({
          where: { id: emailAccountId },
          data: { watchEmailsExpirationDate: result.expirationDate },
        });
        return { success: true, expirationDate: result.expirationDate };
      }
    }

    const error = new Error("Provider returned no result for watch setup");
    return { success: false, error };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    const isInsufficientPermissions = errorMessage.includes(
      "Request had insufficient authentication scopes.",
    );
    const isInvalidGrant = isInvalidGrantError(error);

    if (isInsufficientPermissions || isInvalidGrant) {
      logger.warn("Auth failure while watching inbox - cleaning up tokens", {
        error,
      });
      await cleanupInvalidTokens({
        emailAccountId,
        reason: isInvalidGrant ? "invalid_grant" : "insufficient_permissions",
        failedAccessToken,
        logger,
      }).catch((cleanupError) =>
        logger.warn("Failed to clean up watch authentication failure", {
          cleanupError,
        }),
      );
    } else if (!isGmailCallDeferredError(error)) {
      captureException(error, { emailAccountId });
    }

    return { success: false, error };
  }
}

export async function stopWatchingEmailAccount({
  emailAccountId,
  provider,
  subscriptionId,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  subscriptionId: string | null;
  logger: Logger;
}) {
  let emailProvider: EmailProvider;
  try {
    emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
  } catch (error) {
    logger.warn("Could not create provider to unwatch account", {
      emailAccountId,
      error,
    });
    return;
  }

  await unwatchEmails({
    emailAccountId,
    provider: emailProvider,
    subscriptionId,
    logger,
  });
}

export async function unwatchEmails({
  emailAccountId,
  provider,
  subscriptionId,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  subscriptionId?: string | null;
  logger: Logger;
}) {
  try {
    logger.info("Unwatching emails");

    await provider.unwatchEmails(subscriptionId || undefined);
  } catch (error) {
    if (isInvalidGrantError(error)) {
      logger.warn("Error unwatching emails, invalid grant");
    } else {
      logger.error("Error unwatching emails", { error });
      captureException(error, { emailAccountId });
    }
  }

  // Clear the watch data regardless of provider
  await prisma.emailAccount.updateMany({
    where: { id: emailAccountId },
    data: {
      watchEmailsExpirationDate: null,
      watchEmailsSubscriptionId: null,
    },
  });
}

// The profile lookup adds a request per account, and the hourly renewal already
// runs close to its time budget, so each account is checked once a day in a
// fixed hour slot instead of on every run.
function isEmailSyncDue(emailAccountId: string, now: Date) {
  let hash = 0;
  for (const char of emailAccountId) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash % 24 === now.getUTCHours();
}
