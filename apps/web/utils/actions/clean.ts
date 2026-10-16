"use server";

import { after } from "next/server";
import {
  cleanInboxSchema,
  undoCleanInboxSchema,
  changeKeepToDoneSchema,
} from "@/utils/actions/clean.validation";
import {
  getLabel,
  getOrCreateInboxZeroLabel,
  GmailLabel,
  labelThread,
} from "@/utils/gmail/label";
import { queueCleanInboxThreads } from "@/app/api/clean/queue-inbox";
import { getInboxZeroLabelNames } from "@/utils/label";
import prisma from "@/utils/prisma";
import { CleanAction } from "@/generated/prisma/enums";
import { updateThread } from "@/utils/redis/clean";
import { getGmailClientForEmail } from "@/utils/email-account-client";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { getUserPremium } from "@/utils/user/get";
import { isActivePremium } from "@/utils/premium";
import { ONE_DAY_MS } from "@/utils/date";

export const cleanInboxAction = actionClient
  .metadata({ name: "cleanInbox" })
  .inputSchema(cleanInboxSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, userId, logger },
      parsedInput: { action, instructions, daysOld, skips, maxEmails },
    }) => {
      if (!isGoogleProvider(provider)) {
        throw new SafeError(
          "Clean inbox is only supported for Google accounts",
        );
      }

      const premium = await getUserPremium({ userId });
      if (!premium) throw new SafeError("User not premium");
      if (!isActivePremium(premium)) {
        throw new SafeError(
          "Deep Clean requires an active paid subscription. It isn't available during the free trial.",
        );
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      const [markedDoneLabel, processedLabel] = await Promise.all([
        emailProvider.getOrCreateInboxZeroLabel(
          action === CleanAction.ARCHIVE ? "archived" : "marked_read",
        ),
        emailProvider.getOrCreateInboxZeroLabel("processed"),
      ]);

      const markedDoneLabelId = markedDoneLabel?.id;
      if (!markedDoneLabelId)
        throw new SafeError("Failed to create archived label");

      const processedLabelId = processedLabel?.id;
      if (!processedLabelId)
        throw new SafeError("Failed to create processed label");

      // create a cleanup job
      const job = await prisma.cleanupJob.create({
        data: {
          emailAccountId,
          action,
          instructions,
          daysOld,
          skipReply: skips.reply,
          skipStarred: skips.starred,
          skipCalendar: skips.calendar,
          skipReceipt: skips.receipt,
          skipAttachment: skips.attachment,
          skipConversation: skips.conversation,
        },
      });

      after(() =>
        queueCleanInboxThreads({
          emailProvider,
          logger,
          emailAccountId,
          jobId: job.id,
          action,
          instructions,
          skips,
          markedDoneLabelId,
          processedLabelId,
          maxEmails,
          before: daysOld > 0 ? Date.now() - daysOld * ONE_DAY_MS : undefined,
          queuedCount: 0,
          deferrals: 0,
        }),
      );

      return { jobId: job.id };
    },
  );

export const undoCleanInboxAction = actionClient
  .metadata({ name: "undoCleanInbox" })
  .inputSchema(undoCleanInboxSchema)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { threadId, markedDone, action },
    }) => {
      const gmail = await getGmailClientForEmail({ emailAccountId, logger });

      // nothing to do atm if wasn't marked done
      if (!markedDone) return { success: true };

      // get the label to remove
      let markedDoneLabel: Awaited<ReturnType<typeof getLabel>>;
      for (const name of getInboxZeroLabelNames(
        action === CleanAction.ARCHIVE ? "archived" : "marked_read",
      )) {
        markedDoneLabel ??= await getLabel({ name, gmail });
      }

      await labelThread({
        gmail,
        threadId,
        // undo core action
        addLabelIds:
          action === CleanAction.ARCHIVE
            ? [GmailLabel.INBOX]
            : [GmailLabel.UNREAD],
        // undo our own labelling
        removeLabelIds: markedDoneLabel?.id ? [markedDoneLabel.id] : undefined,
      });

      // Update Redis to mark this thread as undone
      try {
        // We need to get the thread first to get the jobId
        const thread = await prisma.cleanupThread.findFirst({
          where: { emailAccountId, threadId },
          orderBy: { createdAt: "desc" },
        });

        if (thread) {
          await updateThread({
            emailAccountId,
            jobId: thread.jobId,
            threadId,
            update: {
              undone: true,
              archive: false, // Reset the archive status since we've undone it
            },
          });
        }
      } catch (error) {
        logger.error("Failed to update Redis for undone thread", {
          error,
          threadId,
        });
        // Continue even if Redis update fails
      }

      return { success: true };
    },
  );

export const changeKeepToDoneAction = actionClient
  .metadata({ name: "changeKeepToDone" })
  .inputSchema(changeKeepToDoneSchema)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { threadId, action },
    }) => {
      const gmail = await getGmailClientForEmail({ emailAccountId, logger });

      // Get the label to add (archived or marked_read)
      const actionLabel = await getOrCreateInboxZeroLabel({
        key: action === CleanAction.ARCHIVE ? "archived" : "marked_read",
        gmail,
      });

      await labelThread({
        gmail,
        threadId,
        // Apply the action (archive or mark as read)
        removeLabelIds: [
          ...(action === CleanAction.ARCHIVE ? [GmailLabel.INBOX] : []),
          ...(action === CleanAction.MARK_READ ? [GmailLabel.UNREAD] : []),
        ],
        addLabelIds: [...(actionLabel?.id ? [actionLabel.id] : [])],
      });

      // Update Redis to mark this thread with the new status
      try {
        // We need to get the thread first to get the jobId
        const thread = await prisma.cleanupThread.findFirst({
          where: { emailAccountId, threadId },
          orderBy: { createdAt: "desc" },
        });

        if (thread) {
          await updateThread({
            emailAccountId,
            jobId: thread.jobId,
            threadId,
            update: {
              archive: action === CleanAction.ARCHIVE,
              status: "completed",
              undone: true,
            },
          });
        }
      } catch (error) {
        logger.error("Failed to update Redis for changed thread:", {
          error,
          threadId,
        });
        // Continue even if Redis update fails
      }

      return { success: true };
    },
  );
