"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  parseComposeAssistOutcomes,
  recordComposeAssistOutcomeBody,
} from "@/utils/actions/compose-assist.validation";
import { getReplyMemoryRetentionCutoff } from "@/utils/ai/reply/reply-memory";
import prisma from "@/utils/prisma";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";

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
      ctx: { emailAccountId, userId, logger },
      parsedInput: { threadId, messageId, outcome },
    }) => {
      // Matches the compose-assist route's limit: one outcome per suggestion
      // at most, so a person never reaches it and a script can't fill the
      // table. Which message the outcome is for is checked when the reply is
      // sent, against the sent message's threading.
      await assertWithinUserRateLimit({
        scope: "compose-assist-outcome",
        userId,
        limit: 60,
        windowSeconds: 5 * 60,
        logger,
      });
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
