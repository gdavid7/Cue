"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  parseComposeAssistOutcomes,
  recordComposeAssistOutcomeBody,
} from "@/utils/actions/compose-assist.validation";
import { getReplyMemoryRetentionCutoff } from "@/utils/ai/reply/reply-memory";
import prisma from "@/utils/prisma";

// The latest few say the most about this reply; older ones only add cost.
const MAX_OUTCOMES_PER_REPLY = 5;

/**
 * Remembers what the user did with one of Cue's suggestions in a reply, so
 * the sent reply teaches reply memories what they kept, changed or turned
 * down. Learning is best effort: a failure here never reaches the composer.
 */
export const recordComposeAssistOutcomeAction = actionClient
  .metadata({ name: "recordComposeAssistOutcome" })
  .inputSchema(recordComposeAssistOutcomeBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { threadId, messageId, outcome },
    }) => {
      try {
        const reply = await prisma.composeAssistReply.findFirst({
          where: {
            emailAccountId,
            threadId,
            messageId,
            draftSendLog: null,
            updatedAt: { gt: getReplyMemoryRetentionCutoff() },
          },
          orderBy: { updatedAt: "desc" },
          select: { id: true, outcomes: true },
        });
        if (!reply) {
          await prisma.composeAssistReply.create({
            data: { emailAccountId, threadId, messageId, outcomes: [outcome] },
          });
          return;
        }
        await prisma.composeAssistReply.update({
          where: { id: reply.id },
          data: {
            outcomes: [
              ...parseComposeAssistOutcomes(reply.outcomes),
              outcome,
            ].slice(-MAX_OUTCOMES_PER_REPLY),
          },
        });
      } catch (error) {
        logger.error("Failed to record compose assist outcome", { error });
      }
    },
  );
