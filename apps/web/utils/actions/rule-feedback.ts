"use server";

import {
  ClassificationFeedbackEventType,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import { actionClient } from "@/utils/actions/safe-action";
import { markNoReplyNeededBody } from "@/utils/actions/rule-feedback.validation";
import { extractEmailAddress } from "@/utils/email";
import { createEmailProvider } from "@/utils/email/provider";
import prisma from "@/utils/prisma";
import { removeConflictingThreadStatusLabels } from "@/utils/reply-tracker/label-helpers";
import { saveClassificationFeedback } from "@/utils/rule/classification-feedback";

/**
 * The user says Cue was wrong that a conversation needs their reply. It leaves
 * Needs reply at once; the To Reply label comes off and the rule learns from
 * the correction when the mailbox can be reached.
 */
export const markNoReplyNeededAction = actionClient
  .metadata({ name: "markNoReplyNeeded" })
  .inputSchema(markNoReplyNeededBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { threadId },
    }) => {
      const where = {
        emailAccountId,
        threadId,
        type: ThreadTrackerType.NEEDS_REPLY,
        resolved: false,
      };
      const [tracker, toReplyRule] = await Promise.all([
        prisma.threadTracker.findFirst({
          where,
          select: { messageId: true },
          orderBy: { sentAt: "desc" },
        }),
        prisma.rule.findUnique({
          where: {
            emailAccountId_systemType: {
              emailAccountId,
              systemType: SystemType.TO_REPLY,
            },
          },
          select: { id: true },
        }),
      ]);
      await prisma.threadTracker.updateMany({
        where,
        data: { resolved: true },
      });

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        await removeConflictingThreadStatusLabels({
          emailAccountId,
          threadId,
          systemType: SystemType.FYI,
          provider: emailProvider,
          logger,
        });
        if (!tracker || !toReplyRule) return;

        const message = await emailProvider.getMessage(tracker.messageId);
        await saveClassificationFeedback({
          emailAccountId,
          sender: extractEmailAddress(message.headers.from),
          ruleId: toReplyRule.id,
          threadId,
          messageId: tracker.messageId,
          eventType: ClassificationFeedbackEventType.LABEL_REMOVED,
          logger,
        });
      } catch (error) {
        // The thread is already off Needs reply; the label and the lesson can wait.
        logger.warn("Could not finish the no-reply correction", { error });
      }
    },
  );
