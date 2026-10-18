"use server";

import { after } from "next/server";
import { headers } from "next/headers";
import { env } from "@/env";
import {
  actionClientUser,
  adminActionClient,
} from "@/utils/actions/safe-action";
import {
  setFeedbackStatusBody,
  submitFeedbackBody,
} from "@/utils/actions/feedback.validation";
import prisma from "@/utils/prisma";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import type { Logger } from "@/utils/logger";
import { trackProductFeedback } from "@/utils/posthog";

export const submitFeedbackAction = actionClientUser
  .metadata({ name: "submitFeedback" })
  .inputSchema(submitFeedbackBody)
  .action(
    async ({
      ctx: { userId, userEmail, logger },
      parsedInput: { feedback, page, emailAccountId },
    }) => {
      await assertWithinUserRateLimit({
        scope: "feedback",
        userId,
        limit: 10,
        windowSeconds: 60 * 60,
        logger,
      });

      // Only keep an account the user owns; a stale or forged id is dropped.
      const ownedAccount = emailAccountId
        ? await prisma.emailAccount.findFirst({
            where: { id: emailAccountId, userId },
            select: { id: true },
          })
        : null;

      const userAgent = (await headers()).get("user-agent");

      await prisma.feedback.create({
        data: {
          userId,
          emailAccountId: ownedAccount?.id,
          message: feedback,
          page,
          userAgent: userAgent?.slice(0, 500),
        },
      });

      // The row above is the record; these are best-effort extras.
      after(async () => {
        try {
          await trackProductFeedback(userEmail, feedback);
        } catch (error) {
          logger.warn("Failed to send product feedback to PostHog", { error });
        }
        await sendFeedbackToWebhook({ email: userEmail, feedback, logger });
      });

      return { success: true };
    },
  );

export const setFeedbackStatusAction = adminActionClient
  .metadata({ name: "setFeedbackStatus" })
  .inputSchema(setFeedbackStatusBody)
  .action(async ({ parsedInput: { id, status } }) => {
    await prisma.feedback.update({ where: { id }, data: { status } });
    return { success: true };
  });

async function sendFeedbackToWebhook({
  email,
  feedback,
  logger,
}: {
  email: string;
  feedback: string;
  logger: Logger;
}) {
  if (!env.FEEDBACK_WEBHOOK_URL) return;

  try {
    const response = await fetch(env.FEEDBACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        text: "New product feedback received",
        blocks: [
          {
            type: "section",
            text: { type: "plain_text", text: `User: ${email}` },
          },
          ...splitFeedbackForSlack(feedback).map((text) => ({
            type: "section",
            text: { type: "plain_text", text },
          })),
        ],
      }),
    });

    if (!response.ok) {
      logger.error("Failed to send product feedback webhook", {
        status: response.status,
      });
    }
  } catch (error) {
    logger.error("Failed to send product feedback webhook", { error });
  }
}

function splitFeedbackForSlack(feedback: string) {
  const sectionTextLimit = 3000;
  const sections: string[] = [];

  for (let index = 0; index < feedback.length; index += sectionTextLimit) {
    sections.push(feedback.slice(index, index + sectionTextLimit));
  }

  return sections;
}
