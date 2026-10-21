import {
  ExecutedRuleStatus,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import { ACTIVATION_EVENTS } from "@/utils/analytics/activation";
import { createScopedLogger, type Logger } from "@/utils/logger";
import {
  getErrorTypes,
  getWatchStatus,
} from "@/utils/analytics/mailbox-health";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { hasTimeBeforeRequestDeadline } from "@/utils/request-deadline-reader";

// Mailboxes at least an hour past first sign-in (EmailAccount.createdAt) that
// have not had the event get it. The tick runs every few minutes or more
// often, so a mailbox is usually seen soon after the hour. The window still spans more than a day so a
// deployment that can only tick daily (Vercel Hobby) covers every mailbox.
const MIN_AGE_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 26 * 60 * 60 * 1000;
// Above a day's sign-ups, so a daily tick never leaves one behind. Oldest go
// first, as they leave the window soonest.
export const FIRST_HOUR_HEALTH_MAX_PER_RUN = 200;
// Bounds the rows read when a more frequent tick already sent most of them.
const MAX_CANDIDATES = 2000;
// Outlives the age window, so a mailbox is never sent twice, then expires.
const SENT_KEY_TTL_SECONDS = 3 * 24 * 60 * 60;
// Room for the mailbox in progress to finish before the cron is killed.
const MAILBOX_RESERVE_MS = 30_000;

const productLogger = createScopedLogger("product");

/**
 * Logs one aggregate setup-health snapshot per new mailbox about an hour after
 * its first sign-in, so setup failures show up in Axiom without user reports.
 * Counts and states only: never addresses, subjects, content or rule names.
 */
export async function recordFirstHourHealthForNewMailboxes(logger: Logger) {
  const now = new Date();
  const candidates = await prisma.emailAccount.findMany({
    where: {
      createdAt: {
        gt: new Date(now.getTime() - MAX_AGE_MS),
        lte: new Date(now.getTime() - MIN_AGE_MS),
      },
    },
    orderBy: { createdAt: "asc" },
    take: MAX_CANDIDATES,
    select: {
      id: true,
      createdAt: true,
      watchEmailsExpirationDate: true,
      lastSyncedHistoryId: true,
      account: { select: { provider: true, disconnectedAt: true } },
      user: { select: { errorMessages: true } },
    },
  });

  // One read skips the already-sent, so they never use up the cap.
  const sentFlags = candidates.length
    ? await redis.mget<(string | null)[]>(
        ...candidates.map((mailbox) => sentKeyFor(mailbox.id)),
      )
    : [];
  const unsent = candidates.filter((_, i) => !sentFlags[i]);

  let sent = 0;
  let failed = 0;
  for (const [index, mailbox] of unsent.entries()) {
    if (sent + failed >= FIRST_HOUR_HEALTH_MAX_PER_RUN) break;
    // The ones left are the newest, so the last to leave the window.
    if (!hasTimeBeforeRequestDeadline(MAILBOX_RESERVE_MS)) {
      logger.warn("Stopping first-hour health before the deadline", {
        mailboxesLeft: unsent.length - index,
      });
      break;
    }

    const sentKey = sentKeyFor(mailbox.id);
    let claimed = false;
    try {
      claimed =
        (await redis.set(sentKey, "1", {
          nx: true,
          ex: SENT_KEY_TTL_SECONDS,
        })) === "OK";
      // Another tick claimed it since the read.
      if (!claimed) continue;

      productLogger.info(
        ACTIVATION_EVENTS.firstHourHealth,
        await getFirstHourHealth(mailbox, now),
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      // Release the claim so a later tick inside the window retries.
      if (claimed) await redis.del(sentKey).catch(() => {});
      logger.warn("Failed to record activation event", {
        event: ACTIVATION_EVENTS.firstHourHealth,
        emailAccountId: mailbox.id,
        error,
      });
    }
  }

  return {
    candidates: candidates.length,
    unsent: unsent.length,
    sent,
    failed,
  };
}

type Mailbox = {
  id: string;
  createdAt: Date;
  watchEmailsExpirationDate: Date | null;
  lastSyncedHistoryId: string | null;
  account: { provider: string; disconnectedAt: Date | null };
  user: { errorMessages: unknown };
};

async function getFirstHourHealth(mailbox: Mailbox, now: Date) {
  const emailAccountId = mailbox.id;
  const [enabledRules, executedByStatus, skippedNoMatch, trackersByType] =
    await Promise.all([
      prisma.rule.findMany({
        where: { emailAccountId, enabled: true },
        select: { systemType: true },
      }),
      prisma.executedRule.groupBy({
        by: ["status"],
        where: { emailAccountId },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
      prisma.executedRule.count({
        where: {
          emailAccountId,
          status: ExecutedRuleStatus.SKIPPED,
          ruleId: null,
        },
      }),
      prisma.threadTracker.groupBy({
        by: ["type"],
        where: { emailAccountId, resolved: false },
        _count: { _all: true },
      }),
    ]);

  const executedCount = (status: ExecutedRuleStatus) =>
    executedByStatus.find((row) => row.status === status)?._count._all ?? 0;
  const trackerCount = (type: ThreadTrackerType) =>
    trackersByType.find((row) => row.type === type)?._count._all ?? 0;
  // A failure to process mail isn't a rule run.
  const lastRuleRunAt = executedByStatus.reduce<Date | null>(
    (latest, row) =>
      row.status !== ExecutedRuleStatus.ERROR &&
      row._max.createdAt &&
      (!latest || row._max.createdAt > latest)
        ? row._max.createdAt
        : latest,
    null,
  );
  const watchExpiresAt = mailbox.watchEmailsExpirationDate;

  return {
    emailAccountId,
    at: now.toISOString(),
    firstSignInAt: mailbox.createdAt.toISOString(),
    minutesSinceFirstSignIn: minutesBetween(mailbox.createdAt, now),
    provider: mailbox.account.provider,
    enabledRuleCount: enabledRules.length,
    enabledSystemRuleCount: enabledRules.filter((rule) => rule.systemType)
      .length,
    replyTrackingEnabled: enabledRules.some(
      (rule) => rule.systemType === SystemType.TO_REPLY,
    ),
    rulesApplied: executedCount(ExecutedRuleStatus.APPLIED),
    rulesApplying: executedCount(ExecutedRuleStatus.APPLYING),
    rulesSkipped: executedCount(ExecutedRuleStatus.SKIPPED),
    rulesSkippedNoMatch: skippedNoMatch,
    rulesErrored: executedCount(ExecutedRuleStatus.ERROR),
    minutesSinceLastRuleRun: lastRuleRunAt
      ? minutesBetween(lastRuleRunAt, now)
      : null,
    needsReplyCount: trackerCount(ThreadTrackerType.NEEDS_REPLY),
    awaitingReplyCount: trackerCount(ThreadTrackerType.AWAITING),
    accountDisconnected: Boolean(mailbox.account.disconnectedAt),
    watchStatus: getWatchStatus(watchExpiresAt, now),
    hasSyncCursor: Boolean(mailbox.lastSyncedHistoryId),
    errorTypes: getErrorTypes(mailbox.user.errorMessages, emailAccountId),
  };
}

function sentKeyFor(emailAccountId: string) {
  return `activation:first-hour-health:${emailAccountId}`;
}

function minutesBetween(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}
