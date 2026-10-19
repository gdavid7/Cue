import { after } from "next/server";
import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/prisma";
import { withPrismaRetry } from "@/utils/prisma-retry";
import { calculateSimilarity } from "@/utils/similarity-score";
import { isDraftUnmodified } from "@/utils/ai/choose-rule/draft-management";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import {
  isMeaningfulDraftEdit,
  saveDraftSendLogReplyMemory,
  syncReplyMemoriesFromDraftSendLogs,
} from "@/utils/ai/reply/reply-memory";
import { stripProviderSignatureFromParsedMessage } from "@/utils/email/signature-normalization";
import {
  replaceMessagingDraftNotificationsWithDraftSentState,
  replaceMessagingDraftNotificationsWithHandledOnWebState,
} from "@/utils/messaging/rule-notifications";
import { emailToContentForAI } from "@/utils/ai/content-sanitizer";
import { FIRST_TIME_EVENTS, trackFirstTimeEvent } from "@/utils/posthog";
import { recordFirstSuggestedReplySent } from "@/utils/analytics/activation";
import { messageRepliesToSourceSender } from "@/utils/email";
import { getDraftSendLogSimilarityFields } from "./draft-similarity";
import { logReplyTrackerError } from "./error-logging";

const DRAFT_SENT_SIMILARITY_THRESHOLD = 0.7;
const SUGGESTION_EXACT_SIMILARITY = 0.85;
const SUGGESTION_MIN_COMPARABLE_LENGTH = 40;
/**
 * Checks if a sent message originated from an AI draft (a rule's draft or a
 * suggested reply the user saved) and logs its similarity.
 */
export async function trackSentDraftStatus({
  emailAccountId,
  message,
  provider,
  logger,
}: {
  emailAccountId: string;
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  const { threadId, id: sentMessageId } = message;

  logger.info("Checking if sent message corresponds to an AI draft");

  if (!sentMessageId) {
    logger.warn("Sent message missing ID, cannot track draft status");
    return;
  }

  const [executedAction, suggestedReplyDraft] = await Promise.all([
    // Find the most recently created draft for this thread
    prisma.executedAction.findFirst({
      where: {
        executedRule: {
          emailAccountId,
          threadId: threadId,
        },
        type: ActionType.DRAFT_EMAIL,
        draftSendLog: null,
        // A mailbox draft from before replies became suggestions, or a
        // suggestion still waiting in Cue (sent as it was, or not used).
        OR: [
          { draftId: { not: null } },
          { draftStatus: DraftEmailStatus.PENDING, content: { not: null } },
        ],
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        createdAt: true,
        content: true,
        to: true,
        draftId: true,
        executedRuleId: true,
        executedRule: {
          select: {
            messageId: true,
            emailAccount: {
              select: {
                signature: true,
              },
            },
          },
        },
      },
    }),
    prisma.suggestedReplyDraft.findFirst({
      where: { emailAccountId, threadId, draftSendLog: null },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        updatedAt: true,
        draftId: true,
        messageId: true,
        content: true,
        executedActionId: true,
        emailAccount: { select: { signature: true } },
      },
    }),
  ]);

  // Saving a suggested reply rewrites the thread's existing draft, rule draft
  // included, and editing the rule's suggestion makes one, so whichever was
  // written last is what the user started from.
  if (
    suggestedReplyDraft &&
    (!executedAction ||
      suggestedReplyDraft.updatedAt > executedAction.createdAt)
  ) {
    await trackSentSuggestedReplyDraft({
      emailAccountId,
      sentMessageId,
      suggestedReplyDraft,
      message,
      provider,
      logger,
    });
    return;
  }

  if (!executedAction) {
    logger.info("No corresponding AI draft or reply suggestion found");
    return;
  }

  const executedActionId = executedAction.id;

  if (!executedAction.draftId) {
    await trackSentReplySuggestion({
      emailAccountId,
      sentMessageId,
      executedAction,
      message,
      provider,
      logger,
    });
    return;
  }

  const {
    draftExists,
    sentMessageRepliesToSource,
    similarityScore,
    sentText,
    draftSendLogData,
  } = await compareSentReplyWithDraft({
    draftId: executedAction.draftId,
    draftText: executedAction.content,
    sourceMessageId: executedAction.executedRule.messageId,
    accountSignature: executedAction.executedRule.emailAccount?.signature,
    sentMessageId,
    message,
    provider,
    logger,
  });
  const createDraftSendLogData = () => ({
    executedActionId: executedActionId,
    ...draftSendLogData,
  });

  logger.info("Calculated similarity score", {
    executedActionId,
    similarityScore,
    draftExists,
    sentMessageRepliesToSource,
  });

  if (draftExists || sentMessageRepliesToSource === false) {
    logger.info("Marking AI draft as not sent", {
      executedActionId: executedAction.id,
      draftId: executedAction.draftId,
      similarityScore,
      draftExists,
      sentMessageRepliesToSource,
    });

    // Create DraftSendLog to record the comparison.
    const [draftSendLog] = await withPrismaRetry(
      () =>
        prisma.$transaction([
          prisma.draftSendLog.create({
            data: createDraftSendLogData(),
          }),
          prisma.executedAction.update({
            where: { id: executedActionId },
            data: {
              draftStatus: DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
            },
          }),
        ]),
      { logger },
    );

    logger.info("Created draft send log and marked action as not sent", {
      executedActionId,
      sentMessageRepliesToSource,
    });
    await replaceMessagingDraftNotificationsWithHandledOnWebState({
      executedRuleId: executedAction.executedRuleId,
      logger,
    });
    if (sentMessageRepliesToSource !== false) {
      queueReplyMemoryLearning({
        emailAccountId,
        draftSendLogId: draftSendLog.id,
        draftText: executedAction.content,
        sentText,
        similarityScore,
        provider,
        logger,
      });
    }
    return;
  }

  logger.info(
    "Original AI draft not found (likely sent or deleted), creating send log.",
    {
      executedActionId,
      draftId: executedAction.draftId,
      similarityScore,
    },
  );

  // Gmail and Outlook both make "missing draft" ambiguous: it can mean sent,
  // deleted, moved, or no longer reachable under the stored draft ID. When the
  // sent message targets the original sender, record the lifecycle as likely
  // sent and leave edit strength to similarityScore.
  const draftStatus = getSentDraftStatus({
    similarityScore,
    sentMessageRepliesToSource,
  });
  const wasLikelyDraftSent = isDraftSentStatus(draftStatus);

  const [draftSendLog] = await withPrismaRetry(
    () =>
      prisma.$transaction([
        prisma.draftSendLog.create({
          data: createDraftSendLogData(),
        }),
        prisma.executedAction.update({
          where: { id: executedActionId },
          data: {
            draftStatus,
          },
        }),
      ]),
    { logger },
  );

  logger.info(
    "Successfully created draft send log and updated action status via transaction",
    { executedActionId },
  );

  if (wasLikelyDraftSent) {
    after(() =>
      trackFirstTimeEvent({
        emailAccountId,
        event: FIRST_TIME_EVENTS.FIRST_DRAFT_SENT,
      }),
    );
    await recordFirstSuggestedReplySent(emailAccountId);
  }

  const replaceMessagingDraftNotifications = wasLikelyDraftSent
    ? replaceMessagingDraftNotificationsWithDraftSentState
    : replaceMessagingDraftNotificationsWithHandledOnWebState;
  await replaceMessagingDraftNotifications({
    executedRuleId: executedAction.executedRuleId,
    logger,
  });

  queueReplyMemoryLearning({
    emailAccountId,
    draftSendLogId: draftSendLog.id,
    draftText: executedAction.content,
    sentText,
    similarityScore,
    provider,
    logger,
  });
}

/**
 * Cleans up old AI-generated drafts in a thread.
 * Handles both rule-based drafts (ExecutedAction) and follow-up drafts (ThreadTracker).
 * For rule drafts: checks if unmodified before deleting.
 * For follow-up drafts: deletes unconditionally (stale if new message arrived).
 */
export async function cleanupThreadAIDrafts({
  threadId,
  emailAccountId,
  provider,
  logger,
  excludeMessageId,
}: {
  threadId: string;
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
  excludeMessageId: string;
}) {
  logger.info("Starting cleanup of old AI drafts for thread");

  try {
    // Suggestions for earlier messages were never used: nothing in the
    // mailbox to delete, only their state to settle.
    await prisma.executedAction.updateMany({
      where: {
        executedRule: {
          emailAccountId,
          threadId,
          messageId: { not: excludeMessageId },
        },
        type: ActionType.DRAFT_EMAIL,
        draftId: null,
        draftStatus: DraftEmailStatus.PENDING,
      },
      data: { draftStatus: DraftEmailStatus.CLEANED_UP_UNUSED },
    });

    // Find draft actions that are still pending, or where the user replied
    // without using the draft and the old draft may still need cleanup.
    // Excludes drafts for the current message to avoid deleting a draft that was just created
    const potentialDraftsToClean = await prisma.executedAction.findMany({
      where: {
        executedRule: {
          emailAccountId,
          threadId: threadId,
          messageId: { not: excludeMessageId },
        },
        type: ActionType.DRAFT_EMAIL,
        draftId: { not: null },
        draftStatus: {
          in: [
            DraftEmailStatus.PENDING,
            DraftEmailStatus.REPLIED_WITHOUT_DRAFT,
          ],
        },
      },
      select: {
        id: true,
        draftId: true,
        draftStatus: true,
        content: true,
      },
    });

    if (potentialDraftsToClean.length === 0) {
      logger.info("No relevant old AI drafts found to cleanup");
      return;
    }

    logger.info("Found potential AI drafts to check for cleanup", {
      potentialDraftsToCleanLength: potentialDraftsToClean.length,
    });

    for (const action of potentialDraftsToClean) {
      if (!action.draftId) continue; // Not expected to happen, but to fix TS error

      const actionLoggerOptions = {
        executedActionId: action.id,
        draftId: action.draftId,
      };
      try {
        const draftDetails = await provider.getDraft(action.draftId);

        logger.info("Fetched draft details for cleanup check", {
          ...actionLoggerOptions,
          draftExists: !!draftDetails,
          draftEmbeddedMessageId: draftDetails?.id,
          draftThreadId: draftDetails?.threadId,
          hasTextPlain: !!draftDetails?.textPlain,
          hasTextHtml: !!draftDetails?.textHtml,
        });
        logger.trace("Draft content preview", {
          ...actionLoggerOptions,
          draftTextPreview: (
            draftDetails?.textPlain || draftDetails?.textHtml
          )?.slice(0, 100),
        });

        if (draftDetails?.textPlain || draftDetails?.textHtml) {
          // Draft exists, check if modified
          // Pass full draftDetails to properly handle Outlook HTML content
          const similarityScore = calculateSimilarity(
            action.content,
            draftDetails,
          );
          const isUnmodified = action.content
            ? isDraftUnmodified({
                originalContent: action.content,
                currentDraft: draftDetails,
                logger,
              })
            : false;

          logger.info("Checked existing draft for modification", {
            ...actionLoggerOptions,
            draftEmbeddedMessageId: draftDetails.id,
            similarityScore,
            isUnmodified,
          });
          logger.trace("Original content preview for similarity check", {
            ...actionLoggerOptions,
            originalContentPreview: action.content?.slice(0, 100),
          });

          if (isUnmodified) {
            logger.info("Draft is unmodified, proceeding with deletion", {
              ...actionLoggerOptions,
              draftEmbeddedMessageId: draftDetails.id,
              draftThreadId: draftDetails.threadId,
            });
            const statusData = getDraftCleanupStatusData({
              draftStatus: action.draftStatus,
              status: DraftEmailStatus.CLEANED_UP_UNUSED,
            });
            await Promise.all([
              provider.deleteDraft(action.draftId),
              statusData
                ? withPrismaRetry(
                    () =>
                      prisma.executedAction.update({
                        where: { id: action.id },
                        data: statusData,
                      }),
                    { logger },
                  )
                : Promise.resolve(),
            ]);
            logger.info("Deleted unmodified draft.", actionLoggerOptions);
          } else {
            logger.info(
              "Draft has been modified, skipping deletion.",
              actionLoggerOptions,
            );
          }
        } else {
          logger.info(
            "Draft no longer exists, tracking cleanup status.",
            actionLoggerOptions,
          );
          const statusData = getDraftCleanupStatusData({
            draftStatus: action.draftStatus,
            status: DraftEmailStatus.MISSING_FROM_PROVIDER,
          });
          if (statusData) {
            await withPrismaRetry(
              () =>
                prisma.executedAction.update({
                  where: { id: action.id },
                  data: statusData,
                }),
              { logger },
            );
          }
        }
      } catch (error) {
        await logReplyTrackerError({
          logger,
          emailAccountId,
          scope: "draft-tracking",
          message: "Error checking draft for cleanup",
          operation: "check-draft-for-cleanup",
          context: actionLoggerOptions,
          error,
        });
      }
    }

    // Also clean up follow-up drafts for this thread (safety net).
    // clearFollowUpLabel already handles this synchronously, so this will
    // typically find nothing. Kept as a fallback for non-standard code paths.
    const followUpTrackers = await prisma.threadTracker.findMany({
      where: {
        emailAccountId,
        threadId,
        followUpDraftId: { not: null },
      },
      select: {
        id: true,
        followUpDraftId: true,
      },
    });

    if (followUpTrackers.length > 0) {
      logger.info("Found follow-up drafts to cleanup", {
        count: followUpTrackers.length,
      });

      for (const tracker of followUpTrackers) {
        if (!tracker.followUpDraftId) continue;

        try {
          await provider.deleteDraft(tracker.followUpDraftId);
          await prisma.threadTracker.update({
            where: { id: tracker.id },
            data: { followUpDraftId: null },
          });
          logger.info("Deleted follow-up draft", {
            trackerId: tracker.id,
            draftId: tracker.followUpDraftId,
          });
        } catch (error) {
          logger.error("Error deleting follow-up draft", {
            trackerId: tracker.id,
            draftId: tracker.followUpDraftId,
            error,
          });
        }
      }
    }

    logger.info("Completed cleanup of AI drafts for thread");
  } catch (error) {
    logger.error("Error during thread draft cleanup", { error });
  }
}

function queueReplyMemoryLearning({
  emailAccountId,
  draftSendLogId,
  draftText,
  sentText,
  similarityScore,
  provider,
  logger,
}: {
  emailAccountId: string;
  draftSendLogId: string;
  draftText?: string | null;
  sentText: string | null;
  similarityScore: number;
  provider: EmailProvider;
  logger: Logger;
}) {
  if (!draftText || !sentText) return;

  const replyMemorySentText = sentText.slice(0, 4000);

  if (
    !isMeaningfulDraftEdit({
      draftText,
      sentText: replyMemorySentText,
      similarityScore,
    })
  ) {
    return;
  }

  after(async () => {
    try {
      await saveDraftSendLogReplyMemory({
        draftSendLogId,
        sentText: replyMemorySentText,
      });
      await syncReplyMemoriesFromDraftSendLogs({
        emailAccountId,
        provider,
        logger,
      });
    } catch (error) {
      logger.error("Failed to learn reply memories from draft edit", {
        error,
        draftSendLogId,
      });
    }
  });
}

async function trackSentSuggestedReplyDraft({
  emailAccountId,
  sentMessageId,
  suggestedReplyDraft,
  message,
  provider,
  logger,
}: {
  emailAccountId: string;
  sentMessageId: string;
  suggestedReplyDraft: {
    id: string;
    draftId: string;
    messageId: string;
    content: string;
    executedActionId: string | null;
    emailAccount: { signature: string | null };
  };
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  const suggestedReplyDraftId = suggestedReplyDraft.id;
  const {
    draftExists,
    sentMessageRepliesToSource,
    similarityScore,
    sentText,
    draftSendLogData,
  } = await compareSentReplyWithDraft({
    draftId: suggestedReplyDraft.draftId,
    draftText: suggestedReplyDraft.content,
    sourceMessageId: suggestedReplyDraft.messageId,
    accountSignature: suggestedReplyDraft.emailAccount.signature,
    sentMessageId,
    message,
    provider,
    logger,
  });

  const draftSendLog = await withPrismaRetry(
    () =>
      prisma.draftSendLog.create({
        data: { suggestedReplyDraftId, ...draftSendLogData },
      }),
    { logger },
  );

  logger.info("Created draft send log for saved suggested reply", {
    suggestedReplyDraftId,
    similarityScore,
    draftExists,
    sentMessageRepliesToSource,
  });

  // A draft still in the mailbox means this send was some other message.
  const draftStatus =
    draftExists || sentMessageRepliesToSource === false
      ? DraftEmailStatus.REPLIED_WITHOUT_DRAFT
      : getSentDraftStatus({ similarityScore, sentMessageRepliesToSource });
  if (isDraftSentStatus(draftStatus)) {
    await recordFirstSuggestedReplySent(emailAccountId);
  }
  // The rule's suggestion this draft began as was used, or not, with it.
  if (suggestedReplyDraft.executedActionId) {
    const executedActionId = suggestedReplyDraft.executedActionId;
    await withPrismaRetry(
      () =>
        prisma.executedAction.updateMany({
          where: {
            id: executedActionId,
            draftId: null,
            // A newer message may have settled it as unused meanwhile; the
            // draft it became says otherwise.
            draftStatus: {
              in: [
                DraftEmailStatus.PENDING,
                DraftEmailStatus.CLEANED_UP_UNUSED,
              ],
            },
          },
          data: { draftStatus },
        }),
      { logger },
    );
  }

  if (sentMessageRepliesToSource === false) return;

  queueReplyMemoryLearning({
    emailAccountId,
    draftSendLogId: draftSendLog.id,
    draftText: suggestedReplyDraft.content,
    sentText,
    similarityScore,
    provider,
    logger,
  });
}

/**
 * A reply sent while the rule's suggestion waited in Cue: sent as suggested
 * (from the reader, without an edit), or written some other way. There is no
 * mailbox draft to have disappeared, so only how close the sent text is to the
 * suggestion says it was used. Either way the comparison teaches reply
 * memories, as a draft's does.
 */
async function trackSentReplySuggestion({
  emailAccountId,
  sentMessageId,
  executedAction,
  message,
  provider,
  logger,
}: {
  emailAccountId: string;
  sentMessageId: string;
  executedAction: {
    id: string;
    content: string | null;
    /** Set when the rule's reply goes to someone other than the sender. */
    to?: string | null;
    executedRuleId: string;
    executedRule: {
      messageId: string;
      emailAccount: { signature: string | null } | null;
    };
  };
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  const executedActionId = executedAction.id;
  const toSomeoneElse = Boolean(executedAction.to?.trim());
  const {
    sentMessageRepliesToSource,
    similarityScore,
    sentText,
    draftSendLogData,
  } = await compareSentReplyWithDraft({
    draftId: null,
    draftText: executedAction.content,
    sourceMessageId: executedAction.executedRule.messageId,
    accountSignature: executedAction.executedRule.emailAccount?.signature,
    sentMessageId,
    message,
    provider,
    logger,
  });

  // A short suggestion ("Thanks!") is close to many replies, so it needs a
  // near-exact match to count as used.
  const wasUsed =
    (toSomeoneElse || sentMessageRepliesToSource !== false) &&
    (similarityScore >= SUGGESTION_EXACT_SIMILARITY ||
      (similarityScore >= DRAFT_SENT_SIMILARITY_THRESHOLD &&
        normalizedLength(executedAction.content) >=
          SUGGESTION_MIN_COMPARABLE_LENGTH));
  const draftStatus = wasUsed
    ? DraftEmailStatus.LIKELY_SENT
    : DraftEmailStatus.REPLIED_WITHOUT_DRAFT;

  const [draftSendLog] = await withPrismaRetry(
    () =>
      prisma.$transaction([
        prisma.draftSendLog.create({
          data: { executedActionId, ...draftSendLogData },
        }),
        prisma.executedAction.update({
          where: { id: executedActionId },
          data: { draftStatus },
        }),
      ]),
    { logger },
  );

  logger.info("Created draft send log for reply suggestion", {
    executedActionId,
    similarityScore,
    draftStatus,
    sentMessageRepliesToSource,
  });

  const wasSent = isDraftSentStatus(draftStatus);
  if (wasSent) {
    after(() =>
      trackFirstTimeEvent({
        emailAccountId,
        event: FIRST_TIME_EVENTS.FIRST_DRAFT_SENT,
      }),
    );
    await recordFirstSuggestedReplySent(emailAccountId);
  }
  await (wasSent
    ? replaceMessagingDraftNotificationsWithDraftSentState
    : replaceMessagingDraftNotificationsWithHandledOnWebState)({
    executedRuleId: executedAction.executedRuleId,
    logger,
  });

  if (!toSomeoneElse && sentMessageRepliesToSource === false) return;

  queueReplyMemoryLearning({
    emailAccountId,
    draftSendLogId: draftSendLog.id,
    draftText: executedAction.content,
    sentText,
    similarityScore,
    provider,
    logger,
  });
}

async function compareSentReplyWithDraft({
  draftId,
  draftText,
  sourceMessageId,
  accountSignature,
  sentMessageId,
  message,
  provider,
  logger,
}: {
  /** Null for a suggestion that never became a mailbox draft. */
  draftId: string | null;
  draftText: string | null;
  sourceMessageId: string;
  accountSignature: string | null | undefined;
  sentMessageId: string;
  message: ParsedMessage;
  provider: EmailProvider;
  logger: Logger;
}) {
  const [draft, sourceMessage] = await Promise.all([
    draftId ? provider.getDraft(draftId) : null,
    provider.getMessage(sourceMessageId).catch((error) => {
      logger.warn("Failed to load source message for sent draft tracking", {
        error,
        draftId,
      });
      return null;
    }),
  ]);

  // Pass full message to properly handle Outlook HTML content
  const similarityScore = calculateSimilarity(draftText, message, {
    excludedSignatures: accountSignature ? [accountSignature] : [],
  });
  const sentMessageRepliesToSource =
    sourceMessage &&
    messageRepliesToSourceSender({
      sentMessage: message,
      sourceMessage,
    });
  const sentText = getSentReplyText(message);
  const similarityFields = getDraftSendLogSimilarityFields({
    draftText,
    sentMessage: message,
    sentText,
    accountSignature,
    draftExists: !!draft,
    sentMessageRepliesToSource,
  });

  return {
    draftExists: !!draft,
    sentMessageRepliesToSource,
    similarityScore,
    sentText,
    draftSendLogData: {
      sentMessageId,
      similarityScore,
      sentText,
      ...similarityFields,
    },
  };
}

function getSentReplyText(message: ParsedMessage): string | null {
  const sentText = emailToContentForAI(
    stripProviderSignatureFromParsedMessage(message),
    {
      maxLength: 0,
      extractReply: true,
      removeForwarded: true,
    },
  ).trim();

  return sentText || null;
}

function getSentDraftStatus({
  similarityScore,
  sentMessageRepliesToSource,
}: {
  similarityScore: number;
  sentMessageRepliesToSource: boolean | null;
}): DraftEmailStatus {
  if (
    sentMessageRepliesToSource ||
    similarityScore >= DRAFT_SENT_SIMILARITY_THRESHOLD
  ) {
    return DraftEmailStatus.LIKELY_SENT;
  }
  return DraftEmailStatus.REPLIED_WITHOUT_DRAFT;
}

function isDraftSentStatus(status: DraftEmailStatus): boolean {
  return status === DraftEmailStatus.LIKELY_SENT;
}

function getDraftCleanupStatusData({
  draftStatus,
  status,
}: {
  draftStatus?: DraftEmailStatus | null;
  status: DraftEmailStatus;
}): { draftStatus: DraftEmailStatus } | null {
  if (
    draftStatus &&
    draftStatus !== DraftEmailStatus.PENDING &&
    draftStatus !== DraftEmailStatus.REPLIED_WITHOUT_DRAFT
  ) {
    return null;
  }
  return { draftStatus: status };
}

function normalizedLength(text: string | null) {
  return (text ?? "").replace(/\s+/g, "").length;
}
