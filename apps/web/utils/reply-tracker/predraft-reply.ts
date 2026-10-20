import {
  ActionType,
  DraftEmailStatus,
  ExecutedActionStatus,
  ExecutedRuleStatus,
  SystemType,
} from "@/generated/prisma/enums";
import type { RunRulesResult } from "@/utils/ai/choose-rule/run-rules";
import type { EmailProvider } from "@/utils/email/types";
import { TRIAGE_AI_LABELS } from "@/utils/llms/spend-bucket";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { captureException } from "@/utils/error";
import { runWithGmailQuota } from "@/utils/gmail/quota";
import {
  claimPredraftMessage,
  claimPredraftSlot,
} from "@/utils/redis/predraft-cap";
import { logReplySuggestionStage } from "@/utils/reply-tracker/suggestion-funnel";
import {
  getSuggestedReplySettings,
  suggestReply,
} from "@/utils/thread-context/suggest-reply";
import type { ParsedMessage } from "@/utils/types";
import { collectAiUsage } from "@/utils/usage";

type PredraftOutcome =
  | "not-needed"
  | "draft-replies-not-on"
  | "already-suggested"
  | "daily-cap"
  | "no-suggestion"
  | "drafted"
  | "failed";

/**
 * Writes Cue's reply suggestion for incoming mail the rules just filed To
 * Reply, so the inbox and Today can say a reply is ready and the reader opens
 * it at once instead of writing one then. It is the reader's own grounded
 * suggestion, on the cheap tier, kept where a rule's suggestion waits: on the
 * To Reply run, as a pending draft action with no mailbox draft.
 *
 * Only with "Auto draft replies" on, which is what lets Cue reply unasked;
 * never twice for a message, so not where a rule already wrote one; and at
 * most the daily cap per account.
 *
 * Nobody asked for it, so its Gmail reads run at background priority (D-086),
 * behind sync and the user's own requests. It never throws: a failure is
 * logged and reported, by ID only.
 */
export async function predraftReply(
  options: PredraftOptions,
): Promise<PredraftOutcome> {
  try {
    return await runWithGmailQuota({ priority: "background" }, () =>
      predraft(options),
    );
  } catch (error) {
    options.logger.error("Reply pre-draft failed", { error });
    captureException(error, { emailAccountId: options.emailAccount.id });
    return "failed";
  }
}

type PredraftOptions = {
  emailAccount: { id: string; email: string };
  message: ParsedMessage;
  results: RunRulesResult[];
  provider: EmailProvider;
  logger: Logger;
  now?: Date;
};

async function predraft({
  emailAccount,
  message,
  results,
  provider,
  logger,
  now = new Date(),
}: PredraftOptions): Promise<PredraftOutcome> {
  const filedToReply = results.some(
    (result) =>
      !result.existing &&
      result.status !== ExecutedRuleStatus.SKIPPED &&
      result.rule?.systemType === SystemType.TO_REPLY,
  );
  if (!filedToReply) return "not-needed";

  const settings = await getSuggestedReplySettings(emailAccount.id);
  if (settings.draftReplies !== "on") return "draft-replies-not-on";

  const [toReplyRun, ruleSuggestion] = await Promise.all([
    prisma.executedRule.findFirst({
      where: {
        emailAccountId: emailAccount.id,
        threadId: message.threadId,
        messageId: message.id,
        status: { not: ExecutedRuleStatus.SKIPPED },
        rule: { systemType: SystemType.TO_REPLY },
      },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    }),
    // Any reply a rule drafted for this message, whatever became of it.
    prisma.executedAction.findFirst({
      where: {
        type: ActionType.DRAFT_EMAIL,
        executedRule: {
          emailAccountId: emailAccount.id,
          messageId: message.id,
        },
      },
      select: { id: true },
    }),
  ]);
  if (!toReplyRun) return "not-needed";
  if (ruleSuggestion) return "already-suggested";
  // Two deliveries of the same message's webhook pre-draft it once.
  if (
    !(await claimPredraftMessage({
      emailAccountId: emailAccount.id,
      messageId: message.id,
      logger,
    }))
  )
    return "already-suggested";

  if (
    !(await claimPredraftSlot({ emailAccountId: emailAccount.id, logger, now }))
  ) {
    logger.info("Reply pre-draft skipped", { reason: "daily-cap" });
    return "daily-cap";
  }

  const { result: suggestion, events } = await collectAiUsage(() =>
    suggestReply({
      emailAccountId: emailAccount.id,
      userEmail: emailAccount.email,
      threadId: message.threadId,
      emailProvider: provider,
      logger,
      settings,
      source: "predraft",
      now,
    }),
  );

  // The model the reply itself was written on; other calls picked its context.
  const model = events.findLast(
    (event) => event.label === TRIAGE_AI_LABELS.predraftReply,
  );
  let executedActionId: string | undefined;
  if (suggestion?.status === "suggested") {
    const action = await prisma.executedAction.create({
      data: {
        executedRuleId: toReplyRun.id,
        type: ActionType.DRAFT_EMAIL,
        content: suggestion.reply,
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
        executionStatus: ExecutedActionStatus.SUCCEEDED,
        executedAt: now,
        draftModelProvider: model?.provider ?? null,
        draftModelName: model?.model ?? null,
        replySuggestionPredrafted: true,
      },
      select: { id: true },
    });
    executedActionId = action.id;
    logReplySuggestionStage({
      logger,
      stage: "generated",
      executedActionId,
      source: "predraft",
    });
  }

  const outcome = executedActionId ? "drafted" : "no-suggestion";
  // What each pre-draft cost, for the daily cap's budget. Counts only.
  logger.info("Reply pre-draft", {
    outcome,
    ...(executedActionId ? { executedActionId } : {}),
    provider: model?.provider ?? null,
    model: model?.model ?? null,
    calls: events.length,
    inputTokens: sum(events, "inputTokens"),
    cachedInputTokens: sum(events, "cachedInputTokens"),
    outputTokens: sum(events, "outputTokens"),
    totalTokens: sum(events, "totalTokens"),
    estimatedCost: sum(events, "estimatedCost"),
  });
  return outcome;
}

function sum<K extends string>(events: Record<K, number>[], field: K): number {
  return events.reduce((total, event) => total + event[field], 0);
}
