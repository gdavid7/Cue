import { subDays } from "date-fns/subDays";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

// Cue's suggestions in a reply that was never sent can no longer teach
// anything once send tracking stops looking for them.
const UNSENT_COMPOSE_ASSIST_RETENTION_DAYS = 7;

export type ReasoningRetentionSkippedResult = {
  skipped: true;
  reason: "not-configured";
};

export type ReasoningRetentionResult = {
  skipped: false;
  cutoff: Date;
  executedRules: number;
  documentFilings: number;
};

export type DraftSentTextRetentionResult = {
  cutoff: Date;
  draftSendLogs: number;
  unsentComposeAssistReplies: number;
  sentComposeAssistReplies: number;
};

export type ReasoningRetentionPolicyResult =
  | ReasoningRetentionSkippedResult
  | ReasoningRetentionResult;

export async function enforceConfiguredReasoningRetention({
  days,
  logger,
  now = new Date(),
}: {
  days?: number;
  logger: Logger;
  now?: Date;
}): Promise<ReasoningRetentionPolicyResult> {
  if (days === undefined) {
    logger.info(
      "Skipping reasoning retention policy because it is not configured",
    );
    return { skipped: true, reason: "not-configured" };
  }

  return enforceReasoningRetention({ days, logger, now });
}

export async function enforceReasoningRetention({
  days,
  logger,
  now = new Date(),
}: {
  days: number;
  logger: Logger;
  now?: Date;
}): Promise<ReasoningRetentionResult> {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error("Reasoning retention days must be a non-negative integer");
  }

  const cutoff = subDays(now, days);

  const [executedRules, documentFilings] = await Promise.all([
    prisma.executedRule.updateMany({
      where: {
        createdAt: { lt: cutoff },
        reason: { not: null },
      },
      data: { reason: null },
    }),
    prisma.documentFiling.updateMany({
      where: {
        createdAt: { lt: cutoff },
        reasoning: { not: null },
      },
      data: { reasoning: null },
    }),
  ]);

  const result: ReasoningRetentionResult = {
    skipped: false,
    cutoff,
    executedRules: executedRules.count,
    documentFilings: documentFilings.count,
  };

  logger.info("Applied reasoning retention policy", result);

  return result;
}

export async function enforceDraftSentTextRetention({
  days,
  logger,
  now = new Date(),
}: {
  days: number;
  logger: Logger;
  now?: Date;
}): Promise<DraftSentTextRetentionResult> {
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(
      "Draft sent text retention days must be a non-negative integer",
    );
  }

  const cutoff = subDays(now, days);
  const unsentCutoff = subDays(
    now,
    Math.min(days, UNSENT_COMPOSE_ASSIST_RETENTION_DAYS),
  );

  const [draftSendLogs, unsentComposeAssistReplies, sentComposeAssistReplies] =
    await Promise.all([
      prisma.draftSendLog.updateMany({
        where: {
          createdAt: { lt: cutoff },
          OR: [
            { sentText: { not: null } },
            { replyMemorySentText: { not: null } },
          ],
        },
        data: {
          sentText: null,
          replyMemorySentText: null,
        },
      }),
      prisma.composeAssistReply.deleteMany({
        where: { updatedAt: { lt: unsentCutoff }, draftSendLog: null },
      }),
      // A sent reply's row stays as the source its memories were learned
      // from; only the text the user and Cue wrote goes.
      prisma.composeAssistReply.updateMany({
        where: {
          createdAt: { lt: cutoff },
          draftSendLog: { isNot: null },
          NOT: { outcomes: { equals: [] } },
        },
        data: { outcomes: [] },
      }),
    ]);

  const result: DraftSentTextRetentionResult = {
    cutoff,
    draftSendLogs: draftSendLogs.count,
    unsentComposeAssistReplies: unsentComposeAssistReplies.count,
    sentComposeAssistReplies: sentComposeAssistReplies.count,
  };

  logger.info("Applied draft sent text retention policy", result);

  return result;
}
