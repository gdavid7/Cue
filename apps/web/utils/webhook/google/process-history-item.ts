import type { gmail_v1 } from "@googleapis/gmail";
import type { ProcessHistoryOptions } from "@/utils/webhook/google/types";
import { HistoryEventType } from "@/utils/webhook/google/types";
import { createEmailProvider } from "@/utils/email/provider";
import { handleLabelRemovedEvent } from "@/utils/webhook/google/process-label-removed-event";
import { handleLabelAddedEvent } from "@/utils/webhook/google/process-label-added-event";
import { processHistoryItem as processHistoryItemShared } from "@/utils/webhook/process-history-item";
import {
  clearMessageProcessing,
  markMessageAsProcessing,
} from "@/utils/redis/message-processing";
import { GmailLabel } from "@/utils/gmail/label";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import type { Logger } from "@/utils/logger";

export async function processHistoryItem(
  historyItem: {
    type: HistoryEventType;
    item:
      | gmail_v1.Schema$HistoryMessageAdded
      | gmail_v1.Schema$HistoryLabelAdded
      | gmail_v1.Schema$HistoryLabelRemoved;
  },
  options: ProcessHistoryOptions,
  logger: Logger,
) {
  const {
    emailAccount,
    hasAutomationRules,
    hasAiAccess,
    rules,
    spamLearnedThreadIds,
  } = options;
  const { type, item } = historyItem;
  const messageId = item.message?.id;
  const threadId = item.message?.threadId;
  const emailAccountId = emailAccount.id;

  if (!messageId || !threadId) return;

  logger.info("Gmail history item received", {
    eventType: type,
    labelIds: item.message?.labelIds,
  });

  const provider = await createEmailProvider({
    emailAccountId,
    provider: "google",
    logger,
  });

  const lockAndProcessShared = async () => {
    const isFree = await markMessageAsProcessing({
      userEmail: emailAccount.email,
      messageId,
    });
    if (!isFree) {
      logger.info("Skipping. Message already being processed.");
      return;
    }

    logger.info("Gmail lock acquired, calling shared processor");

    try {
      return await processHistoryItemShared(
        { messageId, threadId },
        {
          provider,
          isNewMessage: type === HistoryEventType.MESSAGE_ADDED,
          emailAccount,
          hasAutomationRules,
          hasAiAccess,
          rules,
          logger,
        },
      );
    } catch (error) {
      // The history cursor stays before this message so a catch-up retries
      // it; the lock would make that catch-up skip it.
      if (
        isGmailCallDeferredError(error) ||
        isEmailProviderRateLimitError({ error, provider: "google" })
      ) {
        await clearMessageProcessing({
          userEmail: emailAccount.email,
          messageId,
        }).catch((clearError) =>
          logger.warn("Failed to release message processing lock", {
            error: clearError,
          }),
        );
      }
      throw error;
    }
  };

  // Handle Google-specific label events
  if (type === HistoryEventType.LABEL_REMOVED) {
    const labelRemovedItem = item as gmail_v1.Schema$HistoryLabelRemoved;
    if (labelRemovedItem.labelIds?.includes(GmailLabel.SPAM)) {
      spamLearnedThreadIds.delete(threadId);
    }

    logger.info("Processing label removed event for learning");
    return handleLabelRemovedEvent(
      labelRemovedItem,
      {
        emailAccount,
        provider,
      },
      logger,
    );
  } else if (type === HistoryEventType.LABEL_ADDED) {
    const labelAddedItem = item as gmail_v1.Schema$HistoryLabelAdded;

    if (labelAddedItem.labelIds?.includes(GmailLabel.SENT)) {
      return lockAndProcessShared();
    }

    logger.info("Processing label added event for learning");
    return handleLabelAddedEvent(
      labelAddedItem,
      {
        emailAccount,
        provider,
        spamLearnedThreadIds,
      },
      logger,
    );
  }

  return lockAndProcessShared();
}
