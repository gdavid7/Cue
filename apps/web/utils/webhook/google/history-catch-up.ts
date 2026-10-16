import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";
import {
  markGmailHistoryCatchUp,
  raiseGmailHistoryCatchUpTarget,
} from "@/utils/redis/gmail-history-catch-up";
import { publishToQstashAt } from "@/utils/upstash";

export const GMAIL_HISTORY_CATCH_UP_PATH = "/api/google/webhook/catch-up";

// Long enough for the account's Gmail budget to refill past what held the
// history back, short enough that the mail is not noticeably late.
const CATCH_UP_DELAY_MS = 90_000;
const NUDGE_DEBOUNCE_SECONDS = 60;

/**
 * Server-side automation only runs on a Gmail push, and pushes can arrive
 * late or not at all. The client's mail sync sees new mail within seconds,
 * so when it reaches history the server has not processed, this schedules
 * the catch-up. A push that arrives first clears the mark and the catch-up
 * does nothing; the catch-up itself honors the account's Gmail rate limit
 * and quota gate.
 */
export async function nudgeGmailHistoryCatchUp({
  emailAccountId,
  mailboxHistoryId,
  logger,
}: {
  emailAccountId: string;
  mailboxHistoryId: string;
  logger: Logger;
}) {
  // The catch-up only runs while its mark is stored there.
  if (!isEmailProviderRateLimitRedisConfigured()) return;

  try {
    const first = await redis.set(
      `gmail-history-nudge:${emailAccountId}`,
      "1",
      { ex: NUDGE_DEBOUNCE_SECONDS, nx: true },
    );
    if (first !== "OK") return;

    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { lastSyncedHistoryId: true },
    });
    const lastSyncedHistoryId = account?.lastSyncedHistoryId;
    if (
      !lastSyncedHistoryId ||
      BigInt(mailboxHistoryId) <= BigInt(lastSyncedHistoryId)
    )
      return;

    logger.info("Client synced Gmail history the server has not processed", {
      lastSyncedHistoryId,
      mailboxHistoryId,
      historyIdGap: (
        BigInt(mailboxHistoryId) - BigInt(lastSyncedHistoryId)
      ).toString(),
    });
    await markGmailHistoryCatchUp(emailAccountId, logger);
    await scheduleGmailHistoryCatchUp({
      emailAccountId,
      historyId: mailboxHistoryId,
      logger,
    });
  } catch (error) {
    logger.warn("Failed to nudge Gmail history catch-up", { error });
  }
}

/**
 * Processes the account's history again shortly after the Gmail quota gate
 * deferred it, or once Gmail's rate limit on the account lifts, so a quiet
 * mailbox does not wait hours for its next push. Deferrals within one delay
 * window share a single delivery, and a delivery does nothing once a later
 * push has caught up.
 *
 * Resolves whether a delivery was scheduled. It only runs while the caller's
 * catch-up mark is stored.
 */
export async function scheduleGmailHistoryCatchUp({
  emailAccountId,
  historyId,
  retryAt,
  logger,
}: {
  emailAccountId: string;
  historyId: string;
  retryAt?: Date;
  logger: Logger;
}): Promise<boolean> {
  const notBefore = new Date(
    Math.max(Date.now() + CATCH_UP_DELAY_MS, retryAt?.getTime() ?? 0),
  );
  const window = Math.floor(notBefore.getTime() / CATCH_UP_DELAY_MS);
  await raiseGmailHistoryCatchUpTarget(emailAccountId, historyId, logger);
  try {
    const scheduled = await publishToQstashAt({
      path: GMAIL_HISTORY_CATCH_UP_PATH,
      body: { emailAccountId, historyId },
      notBefore,
      deduplicationId: `gmail-history-catch-up-${emailAccountId}-${window}`,
    });
    if (!scheduled)
      logger.info(
        "No scheduler for the Gmail history catch-up; the next push catches up",
      );
    return scheduled;
  } catch (error) {
    logger.warn("Failed to schedule Gmail history catch-up", { error });
    return false;
  }
}
