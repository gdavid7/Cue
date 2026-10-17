import {
  ExecutedRuleStatus,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import { ACTIVATION_EVENTS } from "@/utils/analytics/activation";
import { ErrorType, watchLapsedErrorKey } from "@/utils/error-messages";
import { createScopedLogger, type Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

// Mailboxes whose first sign-in (EmailAccount.createdAt) falls in this age
// window get the event. It needs a tick at least every hour to cover everyone.
const MIN_AGE_MS = 60 * 60 * 1000;
const MAX_AGE_MS = 120 * 60 * 1000;
export const FIRST_HOUR_HEALTH_MAX_PER_RUN = 25;
// Bounds the Redis claims per run when many in the window were already sent.
const MAX_CANDIDATES = 200;
// Outlives the age window, so a mailbox is never sent twice, then expires.
const SENT_KEY_TTL_SECONDS = 24 * 60 * 60;

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

  let sent = 0;
  let failed = 0;
  for (const mailbox of candidates) {
    if (sent + failed >= FIRST_HOUR_HEALTH_MAX_PER_RUN) break;

    const sentKey = `activation:first-hour-health:${mailbox.id}`;
    let claimed = false;
    try {
      claimed =
        (await redis.set(sentKey, "1", {
          nx: true,
          ex: SENT_KEY_TTL_SECONDS,
        })) === "OK";
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

  return { candidates: candidates.length, sent, failed };
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
  const lastRuleRunAt = executedByStatus.reduce<Date | null>(
    (latest, row) =>
      row._max.createdAt && (!latest || row._max.createdAt > latest)
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

function getWatchStatus(expiresAt: Date | null, now: Date) {
  if (!expiresAt) return "missing";
  return expiresAt <= now ? "expired" : "active";
}

// Stored keys are fixed ErrorType names, except the watch-lapsed key, which
// carries the mailbox id and may belong to the user's other mailbox.
function getErrorTypes(errorMessages: unknown, emailAccountId: string) {
  if (!errorMessages || typeof errorMessages !== "object") return [];
  const knownTypes = new Set<string>(Object.values(ErrorType));
  return Object.keys(errorMessages).flatMap((key) => {
    if (key === watchLapsedErrorKey(emailAccountId))
      return [ErrorType.EMAIL_WATCH_LAPSED];
    return knownTypes.has(key) ? [key] : [];
  });
}

function minutesBetween(from: Date, to: Date) {
  return Math.round((to.getTime() - from.getTime()) / 60_000);
}
