import prisma from "@/utils/prisma";
import { captureException } from "@/utils/error";
import type { EmailProvider } from "@/utils/email/types";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import { getOutlookClientForEmailId } from "@/utils/email-account-client";
import { extractErrorInfo } from "@/utils/outlook/retry";
import {
  OUTLOOK_SUBSCRIPTION_LIFETIME_MS,
  renewOutlookWatch,
} from "@/utils/outlook/watch";
import {
  parseSubscriptionHistory,
  cleanupOldHistoryEntries,
  addCurrentSubscriptionToHistory,
} from "@/utils/outlook/subscription-history";

const OUTLOOK_SUBSCRIPTION_RENEWAL_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const OUTLOOK_MAX_REUSE_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Manages Outlook subscriptions, ensuring only one active subscription per email account
 * by canceling old subscriptions before creating new ones.
 */
export class OutlookSubscriptionManager {
  private readonly client: EmailProvider;
  private readonly emailAccountId: string;
  private readonly logger: Logger;

  constructor(client: EmailProvider, emailAccountId: string, logger: Logger) {
    this.client = client;
    this.emailAccountId = emailAccountId;
    this.logger = logger.with({ emailAccountId });
  }

  async createSubscription(options?: { forceRefresh?: boolean }): Promise<{
    expirationDate: Date;
    subscriptionId?: string;
    changed: boolean;
  } | null> {
    const forceRefresh = options?.forceRefresh === true;
    let cancelledSubscriptionId: string | null = null;
    try {
      const existing = await this.getExistingSubscription();

      if (existing?.subscriptionId && existing.expirationDate) {
        const now = new Date();
        const timeUntilExpiry =
          new Date(existing.expirationDate).getTime() - now.getTime();

        if (
          !forceRefresh &&
          timeUntilExpiry > OUTLOOK_SUBSCRIPTION_RENEWAL_THRESHOLD_MS &&
          !shouldRenewAgedSubscription(existing.expirationDate, now)
        ) {
          this.logger.info("Existing subscription is valid; reuse", {
            subscriptionId: existing.subscriptionId,
            expirationDate: existing.expirationDate,
          });
          return {
            expirationDate: new Date(existing.expirationDate),
            subscriptionId: existing.subscriptionId,
            changed: false,
          };
        }

        if (forceRefresh) {
          this.logger.info("Existing subscription explicitly refreshing", {
            subscriptionId: existing.subscriptionId,
            expirationDate: existing.expirationDate,
          });
        } else if (
          timeUntilExpiry <= OUTLOOK_SUBSCRIPTION_RENEWAL_THRESHOLD_MS
        ) {
          this.logger.info("Existing subscription near expiry; renewing", {
            subscriptionId: existing.subscriptionId,
            expirationDate: existing.expirationDate,
          });
        } else {
          this.logger.info("Existing subscription reached max age; renewing", {
            subscriptionId: existing.subscriptionId,
            expirationDate: existing.expirationDate,
          });
        }
      } else {
        this.logger.info("No existing subscription found; creating new");
      }

      if (await this.cancelSubscription(existing?.subscriptionId)) {
        cancelledSubscriptionId = existing?.subscriptionId ?? null;
      }

      const subscription = await this.client.watchEmails();

      if (!subscription) {
        await this.forgetCancelledSubscription(cancelledSubscriptionId);
        return null;
      }

      this.logger.info("Successfully created new subscription", {
        subscriptionId: subscription.subscriptionId,
      });

      return {
        expirationDate: subscription.expirationDate,
        subscriptionId: subscription.subscriptionId,
        changed: true,
      };
    } catch (error) {
      this.logger.error("Failed to create subscription", { error });
      captureException(error, { emailAccountId: this.emailAccountId });
      await this.forgetCancelledSubscription(cancelledSubscriptionId);
      return null;
    }
  }

  /**
   * A cancelled subscription that nothing replaced must not stay recorded as
   * current, or it looks valid until it would have expired and push stays off.
   */
  private async forgetCancelledSubscription(subscriptionId: string | null) {
    if (!subscriptionId) return;
    try {
      await prisma.emailAccount.updateMany({
        where: {
          id: this.emailAccountId,
          watchEmailsSubscriptionId: subscriptionId,
        },
        data: {
          watchEmailsSubscriptionId: null,
          watchEmailsExpirationDate: null,
        },
      });
    } catch (error) {
      this.logger.error("Failed to clear cancelled subscription", {
        subscriptionId,
        error,
      });
    }
  }

  /**
   * Creates (or reuses) a subscription, persists it to the DB when changed,
   * and cleans up orphaned subscriptions on DB failure.
   */
  async createAndPersistSubscription(options?: {
    forceRefresh?: boolean;
  }): Promise<{ expirationDate: Date; subscriptionId: string } | null> {
    const result = await this.createSubscription(options);
    if (!result?.subscriptionId) return null;

    if (result.changed) {
      try {
        await this.updateSubscriptionInDatabase({
          expirationDate: result.expirationDate,
          subscriptionId: result.subscriptionId,
        });
      } catch (error) {
        this.logger.error("Failed to save subscription to database", {
          subscriptionId: result.subscriptionId,
          error,
        });

        try {
          await this.client.unwatchEmails(result.subscriptionId);
          this.logger.info("Canceled orphaned subscription after DB failure", {
            subscriptionId: result.subscriptionId,
          });
        } catch (cancelError) {
          this.logger.error("Failed to cancel orphaned subscription", {
            subscriptionId: result.subscriptionId,
            error: cancelError,
          });
        }

        captureException(error, { emailAccountId: this.emailAccountId });
        return null;
      }
    }

    return {
      expirationDate: result.expirationDate,
      subscriptionId: result.subscriptionId,
    };
  }

  private async cancelSubscription(
    subscriptionId: string | null | undefined,
  ): Promise<boolean> {
    if (!subscriptionId) return false;

    try {
      await this.client.unwatchEmails(subscriptionId);
      this.logger.info("Canceled existing subscription", { subscriptionId });
      return true;
    } catch (error) {
      // The subscription might already be expired/invalid
      this.logger.warn(
        "Failed to cancel existing subscription (may already be expired)",
        { subscriptionId, error },
      );
      return false;
    }
  }

  private async getExistingSubscription() {
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: this.emailAccountId },
      select: {
        watchEmailsSubscriptionId: true,
        watchEmailsExpirationDate: true,
        watchEmailsSubscriptionHistory: true,
        createdAt: true,
      },
    });

    if (!emailAccount) return null;

    return {
      subscriptionId: emailAccount.watchEmailsSubscriptionId || null,
      expirationDate: emailAccount.watchEmailsExpirationDate || null,
      subscriptionHistory: emailAccount.watchEmailsSubscriptionHistory,
      accountCreatedAt: emailAccount.createdAt,
    };
  }

  async updateSubscriptionInDatabase(subscription: {
    expirationDate: Date;
    subscriptionId: string;
  }): Promise<void> {
    const expirationDate = subscription.expirationDate;
    const now = new Date();

    this.logger.info("Updating subscription in database", {
      subscriptionId: subscription.subscriptionId,
      expirationDate,
    });

    const existing = await this.getExistingSubscription();

    let updatedHistory = parseSubscriptionHistory(
      existing?.subscriptionHistory,
      this.logger,
    );
    updatedHistory = cleanupOldHistoryEntries(updatedHistory);

    if (
      existing?.subscriptionId &&
      existing.subscriptionId !== subscription.subscriptionId
    ) {
      updatedHistory = addCurrentSubscriptionToHistory(
        updatedHistory,
        existing.subscriptionId,
        now,
        existing.accountCreatedAt,
        this.logger,
      );

      this.logger.info("Moving old subscription to history", {
        oldSubscriptionId: existing.subscriptionId,
        newSubscriptionId: subscription.subscriptionId,
        historyLength: updatedHistory.length,
      });
    }

    await prisma.emailAccount.update({
      where: { id: this.emailAccountId },
      data: {
        watchEmailsExpirationDate: expirationDate,
        watchEmailsSubscriptionId: subscription.subscriptionId,
        watchEmailsSubscriptionHistory: updatedHistory,
      },
    });

    this.logger.info("Updated subscription in database", {
      subscriptionId: subscription.subscriptionId,
      expirationDate,
      historyEntries: updatedHistory.length,
    });

    // Check if we were immediately overwritten by a concurrent call
    const current = await this.getExistingSubscription();
    if (current?.subscriptionId !== subscription.subscriptionId) {
      this.logger.warn(
        "Detected concurrent subscription update, ensuring our subscription is in history",
        {
          ourSubscriptionId: subscription.subscriptionId,
          currentSubscriptionId: current?.subscriptionId,
        },
      );
      await this.addSubscriptionToHistoryIfMissing(
        subscription.subscriptionId,
        now,
        existing?.accountCreatedAt || now,
      );
    }
  }

  /**
   * Atomically adds a subscription to the history array if it's not already the current one
   * and not already in the history. This handles the case where we were overwritten
   * by a concurrent call before we could finish our update.
   */
  private async addSubscriptionToHistoryIfMissing(
    subscriptionId: string,
    replacedAt: Date,
    accountCreatedAt: Date,
  ): Promise<void> {
    const historyEntry = {
      subscriptionId,
      createdAt: accountCreatedAt.toISOString(),
      replacedAt: replacedAt.toISOString(),
    };

    // Use a raw query to atomically append to the JSONB array only if the subscriptionId
    // isn't already the main one AND isn't already in the history array.
    await prisma.$executeRaw`
      UPDATE "EmailAccount"
      SET "watchEmailsSubscriptionHistory" = 
        COALESCE("watchEmailsSubscriptionHistory", '[]'::jsonb) || ${JSON.stringify([historyEntry])}::jsonb
      WHERE id = ${this.emailAccountId}
        AND "watchEmailsSubscriptionId" != ${subscriptionId}
        AND NOT (
          COALESCE("watchEmailsSubscriptionHistory", '[]'::jsonb) @> ${JSON.stringify([{ subscriptionId }])}::jsonb
        )
    `;
  }
}

function shouldRenewAgedSubscription(expirationDate: Date, now: Date) {
  const subscriptionStartedAt = new Date(
    expirationDate.getTime() - OUTLOOK_SUBSCRIPTION_LIFETIME_MS,
  );
  const subscriptionAgeMs = now.getTime() - subscriptionStartedAt.getTime();

  return subscriptionAgeMs >= OUTLOOK_MAX_REUSE_AGE_MS;
}

/**
 * Renews the account's subscription in place. Only a subscription Microsoft
 * no longer has is replaced, and then the caller should backfill the gap.
 */
export async function renewManagedOutlookSubscription({
  emailAccountId,
  subscriptionId,
  logger,
}: {
  emailAccountId: string;
  subscriptionId: string;
  logger: Logger;
}): Promise<{
  status: "renewed" | "recreated";
  subscriptionId: string | undefined;
}> {
  const outlook = await getOutlookClientForEmailId({ emailAccountId, logger });
  try {
    const renewed = await renewOutlookWatch(
      outlook.getClient(),
      subscriptionId,
      logger,
    );
    if (renewed.expirationDateTime) {
      await prisma.emailAccount.updateMany({
        where: {
          id: emailAccountId,
          watchEmailsSubscriptionId: subscriptionId,
        },
        data: {
          watchEmailsExpirationDate: new Date(renewed.expirationDateTime),
        },
      });
    }
    logger.info("Renewed Outlook subscription", { subscriptionId });
    return { status: "renewed", subscriptionId };
  } catch (error) {
    if (extractErrorInfo(error).status !== 404) throw error;
    logger.warn("Outlook subscription is gone; creating a new one", {
      subscriptionId,
    });
    const created = await createManagedOutlookSubscription({
      emailAccountId,
      logger,
      forceRefresh: true,
    });
    return { status: "recreated", subscriptionId: created?.subscriptionId };
  }
}

export async function createManagedOutlookSubscription({
  emailAccountId,
  logger,
  forceRefresh,
}: {
  emailAccountId: string;
  logger: Logger;
  forceRefresh?: boolean;
}): Promise<{ expirationDate: Date; subscriptionId: string } | null> {
  const provider = await createEmailProvider({
    emailAccountId,
    provider: "microsoft",
    logger,
  });
  const manager = new OutlookSubscriptionManager(
    provider,
    emailAccountId,
    logger,
  );

  return manager.createAndPersistSubscription({ forceRefresh });
}
