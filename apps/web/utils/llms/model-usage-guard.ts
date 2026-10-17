import { env } from "@/env";
import {
  getWeeklyUsageCost,
  getWeeklyUsageCostByBucket,
} from "@/utils/redis/usage";
import { createScopedLogger, type Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { redis } from "@/utils/redis";
import { sendActionRequiredEmail } from "@inboxzero/transactional-email";
import { createUnsubscribeToken } from "@/utils/unsubscribe";
import { createMemoCache } from "@/utils/memo-cache";
import { logRedisFailureOnce } from "@/utils/redis/unavailable-log";
import {
  type AiSpendBucket,
  getAiSpendBucket,
  TRIAGE_SPEND_LIMIT_MULTIPLIER,
} from "@/utils/llms/spend-bucket";

const logger = createScopedLogger("llms/model-usage-guard");
const TRIAL_AI_LIMIT_NOTIFICATION_TTL_SECONDS = 60 * 24 * 60 * 60;
const SPEND_BUCKET_WARNING_TTL_SECONDS = 8 * 24 * 60 * 60;

// Both guards run before every AI call, and a chat turn or a processed email
// makes several in a row. The limits are weekly budgets, so each instance
// rereads a user's spend at most once a minute.
const weeklySpend = createMemoCache<number>({
  ttlMs: 60_000,
  maxEntries: 5000,
});
const weeklySpendByBucket = createMemoCache<
  Awaited<ReturnType<typeof getWeeklyUsageCostByBucket>>
>({
  ttlMs: 60_000,
  maxEntries: 5000,
});
// While a bucket stays over its limit every call in it re-checks the weekly
// warning; this keeps that to one Redis claim per instance per hour.
const spendBucketWarnings = createMemoCache<boolean>({
  ttlMs: 60 * 60_000,
  maxEntries: 5000,
});

export const TRIAL_AI_LIMIT_REACHED_MESSAGE =
  "Your trial has reached the AI usage limit. Start your paid plan now to continue using AI automation.";

type TrialAiUsageLimitStatus =
  | { status: "allowed" }
  | {
      status: "trial_ai_limit_reached";
      message: string;
      weeklySpendUsd: number;
      weeklyLimitUsd: number;
    };

export async function getUserTrialAiUsageLimitStatus(options: {
  userId: string;
}): Promise<TrialAiUsageLimitStatus> {
  const weeklyLimitUsd = env.AI_TRIAL_WEEKLY_SPEND_LIMIT_USD;
  if (!weeklyLimitUsd) return { status: "allowed" };

  const user = await prisma.user.findUnique({
    where: { id: options.userId },
    select: {
      email: true,
      aiApiKey: true,
      emailAccounts: { select: { email: true } },
      premium: {
        select: {
          stripeSubscriptionStatus: true,
          lemonSubscriptionStatus: true,
        },
      },
    },
  });

  if (!user || user.aiApiKey || !isTrialPremium(user.premium)) {
    return { status: "allowed" };
  }

  let weeklySpendUsd = 0;
  try {
    weeklySpendUsd = await getWeeklySpend(
      options.userId,
      getLegacyUsageEmails(user),
    );
  } catch (error) {
    logRedisFailureOnce(logger, "Failed to evaluate trial AI spend status", {
      userId: options.userId,
      error,
    });
    return { status: "allowed" };
  }

  return getTrialAiUsageLimitStatus({ weeklySpendUsd, weeklyLimitUsd });
}

export async function assertTrialAiUsageAllowed(options: {
  userEmail: string;
  hasUserApiKey: boolean;
  label: string;
  userId?: string;
  emailAccountId?: string;
}): Promise<void> {
  if (options.hasUserApiKey) return;
  if (!options.userId || !options.emailAccountId) return;

  const status = await getUserTrialAiUsageLimitStatus({
    userId: options.userId,
  });
  if (status.status === "allowed") return;

  logger.warn("Blocking trial AI call due to weekly spend", {
    label: options.label,
    userId: options.userId,
    emailAccountId: options.emailAccountId,
    weeklySpendUsd: status.weeklySpendUsd,
    weeklyLimitUsd: status.weeklyLimitUsd,
  });

  await sendTrialAiLimitReachedEmailOnce({
    userId: options.userId,
    userEmail: options.userEmail,
    emailAccountId: options.emailAccountId,
    logger,
  });

  throw new SafeError(TRIAL_AI_LIMIT_REACHED_MESSAGE);
}

async function sendTrialAiLimitReachedEmailOnce({
  userId,
  userEmail,
  emailAccountId,
  logger,
}: {
  userId: string;
  userEmail: string;
  emailAccountId: string;
  logger: Logger;
}) {
  const key = getTrialAiLimitNotificationKey(userId);
  const claimedNotification = await redis.set(key, new Date().toISOString(), {
    ex: TRIAL_AI_LIMIT_NOTIFICATION_TTL_SECONDS,
    nx: true,
  });

  if (!claimedNotification) return;

  try {
    const unsubscribeToken = await createUnsubscribeToken({ emailAccountId });

    await sendActionRequiredEmail({
      from: env.RESEND_FROM_EMAIL,
      to: userEmail,
      emailProps: {
        baseUrl: env.NEXT_PUBLIC_BASE_URL,
        email: userEmail,
        unsubscribeToken,
        errorType: "Trial AI Limit Reached",
        errorMessage: TRIAL_AI_LIMIT_REACHED_MESSAGE,
        actionUrl: "/premium",
        actionLabel: "Start paid plan now",
      },
    });

    logger.info("Sent action required email", {
      errorType: "trialAiLimitReached",
    });
  } catch (emailError) {
    logger.error("Failed to send trial AI limit email", {
      error: emailError,
    });

    try {
      await redis.del(key);
    } catch (redisError) {
      logger.error("Failed to clear trial AI limit notification marker", {
        userId,
        error: redisError,
      });
    }
  }
}

export async function shouldForceNanoModel(options: {
  userEmail: string;
  hasUserApiKey: boolean;
  label: string;
  userId?: string;
  emailAccountId?: string;
}): Promise<{
  shouldForce: boolean;
  spendBucket: AiSpendBucket;
  weeklySpendUsd: number | null;
  weeklyLimitUsd: number | null;
}> {
  const spendBucket = getAiSpendBucket(options.label);
  const configuredLimitUsd = env.AI_NANO_WEEKLY_SPEND_LIMIT_USD;
  if (!configuredLimitUsd)
    return {
      shouldForce: false,
      spendBucket,
      weeklySpendUsd: null,
      weeklyLimitUsd: null,
    };
  const weeklyLimitUsd =
    spendBucket === "triage"
      ? configuredLimitUsd * TRIAGE_SPEND_LIMIT_MULTIPLIER
      : configuredLimitUsd;

  if (options.hasUserApiKey) {
    return {
      shouldForce: false,
      spendBucket,
      weeklySpendUsd: null,
      weeklyLimitUsd,
    };
  }

  if (!env.NANO_LLMS) {
    logger.warn("Nano model guard enabled but nano model is not configured", {
      label: options.label,
      userId: options.userId,
      emailAccountId: options.emailAccountId,
    });
    return {
      shouldForce: false,
      spendBucket,
      weeklySpendUsd: null,
      weeklyLimitUsd,
    };
  }
  const userId = options.userId;
  if (!userId) {
    return {
      shouldForce: false,
      spendBucket,
      weeklySpendUsd: null,
      weeklyLimitUsd,
    };
  }

  let weeklySpendUsd: number;
  try {
    const legacyEmails = [options.userEmail];
    const spend = await weeklySpendByBucket.get(
      getWeeklySpendMemoKey(userId, legacyEmails),
      () => getWeeklyUsageCostByBucket({ userId, legacyEmails }),
    );
    weeklySpendUsd = spend[spendBucket];
  } catch (error) {
    logRedisFailureOnce(logger, "Failed to evaluate nano model guard", {
      label: options.label,
      userId: options.userId,
      emailAccountId: options.emailAccountId,
      error,
    });
    return {
      shouldForce: false,
      spendBucket,
      weeklySpendUsd: null,
      weeklyLimitUsd,
    };
  }

  const shouldForce = weeklySpendUsd >= weeklyLimitUsd;
  if (shouldForce) {
    await warnSpendBucketOverLimitOnce({
      userId,
      spendBucket,
      weeklySpendUsd,
      weeklyLimitUsd,
    });
  }

  return { shouldForce, spendBucket, weeklySpendUsd, weeklyLimitUsd };
}

async function warnSpendBucketOverLimitOnce({
  userId,
  spendBucket,
  weeklySpendUsd,
  weeklyLimitUsd,
}: {
  userId: string;
  spendBucket: AiSpendBucket;
  weeklySpendUsd: number;
  weeklyLimitUsd: number;
}) {
  const key = `ai-spend-bucket-over-limit:${spendBucket}:${userId}:${getUtcWeekStart(new Date())}`;
  try {
    await spendBucketWarnings.get(key, async () => {
      const claimed = await redis.set(key, new Date().toISOString(), {
        ex: SPEND_BUCKET_WARNING_TTL_SECONDS,
        nx: true,
      });
      if (claimed) {
        logger.warn("Weekly AI spend bucket over limit", {
          userId,
          spendBucket,
          weeklySpendUsd,
          weeklyLimitUsd,
        });
      }
      return true;
    });
  } catch (error) {
    logRedisFailureOnce(logger, "Failed to record AI spend bucket warning", {
      userId,
      spendBucket,
      error,
    });
  }
}

function isTrialPremium(
  premium:
    | {
        stripeSubscriptionStatus?: string | null;
        lemonSubscriptionStatus?: string | null;
      }
    | null
    | undefined,
) {
  return (
    premium?.stripeSubscriptionStatus === "trialing" ||
    premium?.lemonSubscriptionStatus === "on_trial"
  );
}

function getLegacyUsageEmails(user: {
  email: string | null;
  emailAccounts: Array<{ email: string }>;
}) {
  return Array.from(
    new Set([user.email, ...user.emailAccounts.map(({ email }) => email)]),
  ).flatMap((email) => (email ? [email] : []));
}

function getTrialAiUsageLimitStatus({
  weeklySpendUsd,
  weeklyLimitUsd,
}: {
  weeklySpendUsd: number;
  weeklyLimitUsd: number;
}): TrialAiUsageLimitStatus {
  if (weeklySpendUsd < weeklyLimitUsd) return { status: "allowed" };

  return {
    status: "trial_ai_limit_reached",
    message: TRIAL_AI_LIMIT_REACHED_MESSAGE,
    weeklySpendUsd,
    weeklyLimitUsd,
  };
}

function getTrialAiLimitNotificationKey(userId: string) {
  return `trial-ai-limit-notification:${userId}`;
}

function getWeeklySpend(userId: string, legacyEmails: string[]) {
  return weeklySpend.get(getWeeklySpendMemoKey(userId, legacyEmails), () =>
    getWeeklyUsageCost({ userId, legacyEmails }),
  );
}

function getWeeklySpendMemoKey(userId: string, legacyEmails: string[]) {
  return `${userId}:${[...new Set(legacyEmails)].sort().join(",")}`;
}

// Monday of the current UTC week.
function getUtcWeekStart(now: Date) {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
}
