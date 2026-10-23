import { after } from "next/server";
import prisma from "@/utils/prisma";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { categorizeSender } from "@/utils/categorize/senders/categorize";
import {
  isFilebotEmail,
  isFilebotNotificationMessage,
} from "@/utils/filebot/is-filebot-email";
import { processFilingReply } from "@/utils/drive/handle-filing-reply";
import { getFilableAttachments } from "@/utils/drive/filing-engine";
import { processAttachmentsForFiling } from "@/utils/drive/process-filing-attachments";
import { handleOutboundMessage } from "@/utils/reply-tracker/handle-outbound";
import { cleanupThreadAIDrafts } from "@/utils/reply-tracker/draft-tracking";
import { predraftReply } from "@/utils/reply-tracker/predraft-reply";
import { clearFollowUpLabel } from "@/utils/follow-up/labels";
import { NewsletterStatus } from "@/generated/prisma/enums";
import type { EmailAccount } from "@/generated/prisma/client";
import { canonicalizeEmailAddress, extractNameFromEmail } from "@/utils/email";
import { isIgnoredSender } from "@/utils/filter-ignored-senders";
import type { EmailProvider } from "@/utils/email/types";
import type { ParsedMessage, RuleWithActions } from "@/utils/types";
import type { EmailAccountForDrafting } from "@/utils/ai/choose-rule/choose-args";
import type { Logger } from "@/utils/logger";
import { runWithBackgroundLoggerFlush } from "@/utils/logger-flush";
import { captureException, SafeError } from "@/utils/error";
import { logErrorWithDedupe } from "@/utils/log-error-with-dedupe";
import { sendToReplyPushNotification } from "@/utils/to-reply-push";
import { sendOtpPushNotification } from "@/utils/otp-push";
import { internalDateToDate } from "@/utils/date";
import { sendNewMailWebPush } from "@/utils/web-push/send-new-mail";

export type SharedProcessHistoryOptions = {
  provider: EmailProvider;
  isNewMessage?: boolean;
  rules: RuleWithActions[];
  hasAutomationRules: boolean;
  hasAiAccess: boolean;
  emailAccount: EmailAccountForDrafting &
    Pick<
      EmailAccount,
      | "autoCategorizeSenders"
      | "filingEnabled"
      | "filingPrompt"
      | "filingConfirmationSendEmail"
      | "email"
    >;
  logger: Logger;
};

export async function processHistoryItem(
  {
    messageId,
    threadId,
    message,
  }: {
    messageId: string;
    threadId?: string;
    message?: ParsedMessage;
  },
  options: SharedProcessHistoryOptions,
) {
  const {
    provider,
    emailAccount,
    hasAutomationRules,
    hasAiAccess,
    rules,
    logger,
  } = options;

  const emailAccountId = emailAccount.id;
  const userEmail = emailAccount.email;

  try {
    logger.info("Shared processor started");

    // Use pre-fetched message if provided, otherwise fetch it
    const parsedMessage = message ?? (await provider.getMessage(messageId));

    if (isIgnoredSender(parsedMessage.headers.from)) {
      logger.info("Skipping. Ignored sender.");
      return;
    }

    // Get threadId from message if not provided
    const actualThreadId = threadId || parsedMessage.threadId;

    const hasExistingRule = actualThreadId
      ? await prisma.executedRule.findFirst({
          where: {
            emailAccountId,
            threadId: actualThreadId,
            messageId,
          },
          select: { id: true },
        })
      : null;

    if (hasExistingRule) {
      logger.info("Skipping rules. Rule already exists.");
    }

    const isForFilebot = isFilebotEmail({
      userEmail,
      emailToCheck: parsedMessage.headers.to,
    });

    if (isForFilebot) {
      logger.info("Processing filebot reply.");
      return processFilingReply({
        message: parsedMessage,
        emailAccountId,
        userEmail,
        emailProvider: provider,
        emailAccount,
        logger,
      });
    }

    const isOutbound = provider.isSentMessage(parsedMessage);

    logger.info("Message direction check", {
      isOutbound,
      labelIds: parsedMessage.labelIds,
    });
    logger.trace("Message direction details", {
      from: parsedMessage.headers.from,
      to: parsedMessage.headers.to,
    });

    if (isOutbound) {
      if (
        isFilebotNotificationMessage({
          userEmail,
          from: parsedMessage.headers.from,
          to: parsedMessage.headers.to,
          replyTo: parsedMessage.headers["reply-to"],
        })
      ) {
        logger.info("Skipping. Filebot notification message.");
        return;
      }

      await handleOutboundMessage({
        emailAccount,
        message: parsedMessage,
        provider,
        logger,
      });
      return;
    }

    // Clean up old AI drafts after the response so it never slows processing.
    // Excludes drafts for the current message since rules may have just
    // created one.
    const scheduleDraftCleanup = () => {
      if (!actualThreadId) return;
      after(() =>
        runWithBackgroundLoggerFlush({
          logger,
          task: async () => {
            try {
              await cleanupThreadAIDrafts({
                threadId: actualThreadId,
                emailAccountId,
                provider,
                logger,
                excludeMessageId: messageId,
              });
            } catch (error) {
              logger.error("Error during inbound thread draft cleanup", {
                error,
              });
              captureException(error, { emailAccountId });
            }
          },
          extra: { operation: "cleanup-thread-ai-drafts" },
        }),
      );
    };

    // A muted conversation's new mail skips the inbox, the rules (and their
    // model call) and every notification. The mute lives in Cue's database,
    // never as a mailbox label or filter. Only the message that arrived is
    // archived: the rest of the thread (the user's Sent replies, drafts, mail
    // they moved back) stays where it is, and an update event never re-files.
    const muted =
      options.isNewMessage && actualThreadId
        ? await prisma.mutedThread.findUnique({
            where: {
              emailAccountId_threadId: {
                emailAccountId,
                threadId: actualThreadId,
              },
            },
            select: { id: true },
          })
        : null;
    if (muted) {
      try {
        await provider.archiveMessage(messageId);
        logger.info("Skipping. Muted conversation's new message archived.");
      } catch {
        // Still muted (no rules, no push); the message just stays in the inbox.
        logger.warn("Failed to archive a muted conversation's new message", {
          messageId,
          threadId: actualThreadId,
        });
      }
      scheduleDraftCleanup();
      return;
    }

    // check if unsubscribed
    const email = canonicalizeEmailAddress(parsedMessage.headers.from);
    const sender = await prisma.newsletter.findFirst({
      where: {
        emailAccountId,
        email: { equals: email, mode: "insensitive" },
        status: NewsletterStatus.UNSUBSCRIBED,
      },
    });

    if (sender) {
      await provider.blockUnsubscribedEmail(messageId);
      const receivedAt = internalDateToDate(parsedMessage.internalDate, {
        fallbackToNow: false,
      });
      logger.info("Skipping. Blocked unsubscribed email.", {
        senderId: sender.id,
        receivedAt: Number.isFinite(receivedAt.getTime())
          ? receivedAt.toISOString()
          : null,
      });
      return;
    }

    try {
      await sendOtpPushNotification({
        emailAccountId,
        userId: emailAccount.userId,
        message: parsedMessage,
        logger,
      });
    } catch (error) {
      logger.warn("OTP push notification processing failed", { error });
    }

    // Runs once this message's rules are done so "important" browsers can use
    // their triage, and after the response so sends never hold up processing.
    const scheduleWebPush = () => {
      if (!options.isNewMessage) return;
      after(() =>
        runWithBackgroundLoggerFlush({
          logger,
          task: () =>
            sendNewMailWebPush({
              emailAccountId,
              userId: emailAccount.userId,
              message: parsedMessage,
              logger,
            }),
          extra: { operation: "web-push-new-mail" },
        }),
      );
    };

    if (!hasAiAccess) {
      logger.info("Skipping. No AI access.");
      scheduleWebPush();
      return;
    }

    // categorize a sender if we haven't already
    // this is used for category filters in ai rules
    if (emailAccount.autoCategorizeSenders && email) {
      const sender = email;
      const senderName = extractNameFromEmail(parsedMessage.headers.from);
      const displayName =
        canonicalizeEmailAddress(senderName) === sender
          ? undefined
          : senderName;
      const existingSenders = await prisma.newsletter.findMany({
        where: {
          emailAccountId,
          email: { equals: sender, mode: "insensitive" },
        },
        select: { categoryId: true },
      });
      if (
        existingSenders.length === 0 ||
        existingSenders.some(({ categoryId }) => !categoryId)
      ) {
        await categorizeSender(
          sender,
          emailAccount,
          provider,
          undefined,
          displayName,
        );
      }
    }

    logger.info("Pre-rules check", { hasAutomationRules, hasAiAccess });

    if (!hasExistingRule && hasAutomationRules && hasAiAccess) {
      logger.info("Running rules...");

      const results = await runRules({
        provider,
        message: parsedMessage,
        rules,
        emailAccount,
        isTest: false,
        // Runs for every incoming email, so it bills at mail volume. Bulk
        // processing already runs the same rules on economy.
        modelType: "economy",
        logger,
      });

      // runRules never applies To Reply to mail from the user's own addresses.
      if (options.isNewMessage) {
        await sendToReplyPushNotification({
          emailAccountId,
          userId: emailAccount.userId,
          message: parsedMessage,
          results,
          logger,
        });
      }

      // A reply ready before the user opens the mail, written after the
      // response so it never holds up processing.
      after(() =>
        runWithBackgroundLoggerFlush({
          logger,
          task: async () => {
            await predraftReply({
              emailAccount,
              message: parsedMessage,
              results,
              provider,
              logger,
            });
          },
          extra: { operation: "predraft-reply" },
        }),
      );
    }

    scheduleWebPush();

    // Process attachments for document filing (runs in parallel with rules if both enabled)
    if (
      emailAccount.filingEnabled &&
      emailAccount.filingPrompt &&
      hasAiAccess
    ) {
      after(() =>
        runWithBackgroundLoggerFlush({
          logger,
          task: async () => {
            const extractableAttachments = getFilableAttachments(parsedMessage);

            if (extractableAttachments.length > 0) {
              logger.info("Processing attachments for filing", {
                count: extractableAttachments.length,
              });

              await processAttachmentsForFiling({
                attachments: extractableAttachments,
                emailAccount: {
                  ...emailAccount,
                  filingEnabled: emailAccount.filingEnabled,
                  filingPrompt: emailAccount.filingPrompt,
                  filingConfirmationSendEmail:
                    emailAccount.filingConfirmationSendEmail,
                  email: emailAccount.email,
                },
                message: parsedMessage,
                emailProvider: provider,
                logger,
              });
            }
          },
          extra: { operation: "process-attachments" },
        }),
      );
    }

    // Remove follow-up label if present (they replied, so follow-up no longer needed)
    // This handles the case where we were awaiting a reply from them
    try {
      await clearFollowUpLabel({
        emailAccountId,
        threadId: actualThreadId,
        triggerMessageId: parsedMessage.id,
        provider,
        logger,
      });
    } catch (error) {
      logger.error("Error removing follow-up label on inbound", { error });
      captureException(error, { emailAccountId });
    }

    scheduleDraftCleanup();
  } catch (error: unknown) {
    // Handle provider-specific "not found" errors
    if (error instanceof Error) {
      const isGoogleNotFound =
        error.message === "Requested entity was not found.";

      // Outlook can return ErrorItemNotFound code or "not found in the store" message
      const err = error as { code?: string };
      const isOutlookNotFound =
        err?.code === "ErrorItemNotFound" ||
        err?.code === "itemNotFound" ||
        error.message.includes("ItemNotFound") ||
        error.message.includes("not found in the store") ||
        error.message.includes("ResourceNotFound");

      if (isGoogleNotFound || isOutlookNotFound) {
        logger.info("Message not found");
        return;
      }
    }

    if (error instanceof SafeError) {
      logger.info("Skipping. Known processing error.");
      return;
    }

    await logErrorWithDedupe({
      logger,
      message: "Error processing message",
      error,
      dedupeKeyParts: {
        scope: "webhook/process-history-item",
        emailAccountId,
      },
    });
    throw error;
  }
}
