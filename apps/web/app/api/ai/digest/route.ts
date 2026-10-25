import { NextResponse } from "next/server";
import { type DigestBody, digestBody } from "./validation";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import prisma from "@/utils/prisma";
import { aiSummarizeEmailForDigest } from "@/utils/ai/digest/summarize-email-for-digest";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { withError } from "@/utils/middleware";
import { env } from "@/env";
import { withQstashOrInternal } from "@/utils/qstash";
import {
  releaseDigestSummarySlot,
  reserveDigestSummarySlot,
} from "@/utils/digest/summary-limit";
import { checkHasAccess } from "@/utils/premium/server";
import { upsertDigest } from "@/app/api/ai/digest/upsert-digest";
import { createEmailProvider } from "@/utils/email/provider";
import { isThreadNotFoundError } from "@/utils/email/thread-not-found";
import { emailToContentForAI } from "@/utils/ai/content-sanitizer";

export const POST = withError(
  "digest",
  withQstashOrInternal(async (request) => {
    let logger = request.logger;

    try {
      const body = digestBody.parse(await request.json());
      const { emailAccountId, actionId, messageId, threadId } = body;

      logger = logger.with({ emailAccountId, messageId });

      const emailAccount = await getEmailAccountWithAi({ emailAccountId });
      if (!emailAccount) {
        throw new Error("Email account not found");
      }

      const hasDigestAccess = await checkHasAccess({
        userId: emailAccount.userId,
        minimumTier: "PLUS_MONTHLY",
      });
      if (!hasDigestAccess) {
        logger.info("Skipping digest item because plan does not include it");
        return new NextResponse("OK", { status: 200 });
      }

      const ruleName = actionId
        ? await getRuleNameByExecutedAction(actionId, emailAccountId)
        : null;

      if (!ruleName) {
        logger.warn("Rule name not found for executed action", { actionId });
        return new NextResponse("OK", { status: 200 });
      }

      // Reserved before the mailbox read, so a capped day spends no Gmail calls.
      const summaryReservation = await reserveDigestSummarySlot({
        emailAccountId,
        maxSummariesPer24h: env.DIGEST_MAX_SUMMARIES_PER_24H,
      });
      if (!summaryReservation.reserved) {
        logger.info("Skipping digest item because summary limit was reached", {
          maxSummariesPer24h: env.DIGEST_MAX_SUMMARIES_PER_24H,
        });
        return new NextResponse("OK", { status: 200 });
      }

      let shouldReleaseSummaryReservation = !!summaryReservation.reservationId;

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider: emailAccount.account.provider,
          logger,
        });

        let parsedMessage: ParsedMessage | null;
        try {
          parsedMessage = await emailProvider.getMessage(messageId);
        } catch (error) {
          if (isThreadNotFoundError(error)) {
            parsedMessage = null;
          } else {
            const deferred = getGmailCallDeferredError(error);
            if (!deferred) throw error;
            return await resumeDeferredDigest({
              error,
              retryAfterMs: deferred.retryAfterMs,
              body,
              logger,
            });
          }
        }
        if (!parsedMessage) {
          logger.info("Skipping digest item because the message is gone");
          return new NextResponse("OK", { status: 200 });
        }
        const message = {
          id: messageId,
          threadId,
          from: parsedMessage.headers.from,
          to: parsedMessage.headers.to || "",
          subject: parsedMessage.headers.subject,
          content: emailToContentForAI(parsedMessage),
        };

        // Don't summarize Digest emails (this will actually block all emails that we send, but that's okay)
        if (message.from === env.RESEND_FROM_EMAIL) {
          logger.info("Skipping digest item because it is from us");
          return new NextResponse("OK", { status: 200 });
        }

        const summary = await aiSummarizeEmailForDigest({
          ruleName,
          emailAccount,
          messageToSummarize: message,
        });

        if (!summary?.content) {
          logger.info(
            "Skipping digest item because it is not worth summarizing",
          );
          return new NextResponse("OK", { status: 200 });
        }

        await upsertDigest({
          messageId,
          threadId,
          emailAccountId,
          actionId,
          content: summary,
          logger,
        });

        // Keep Prisma fallback reservations releasable on success to avoid
        // counting a placeholder row in addition to the persisted digest item.
        shouldReleaseSummaryReservation =
          summaryReservation.reservationSource === "prisma";

        return new NextResponse("OK", { status: 200 });
      } finally {
        if (
          summaryReservation.reservationId &&
          shouldReleaseSummaryReservation
        ) {
          await releaseDigestSummarySlot({
            emailAccountId,
            reservationId: summaryReservation.reservationId,
            reservationSource: summaryReservation.reservationSource,
          }).catch((error) => {
            logger.error("Failed to release digest summary reservation", {
              error,
            });
          });
        }
      }
    } catch (error) {
      logger.error("Failed to process digest", { error });
      return new NextResponse("Internal Server Error", { status: 500 });
    }
  }),
);

async function getRuleNameByExecutedAction(
  actionId: string,
  emailAccountId: string,
): Promise<string | null | undefined> {
  const executedAction = await prisma.executedAction.findFirst({
    where: {
      id: actionId,
      executedRule: {
        emailAccountId,
      },
    },
    select: {
      executedRule: {
        select: {
          rule: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  return executedAction?.executedRule?.rule?.name;
}

async function resumeDeferredDigest({
  error,
  retryAfterMs,
  body,
  logger,
}: {
  error: unknown;
  retryAfterMs: number;
  body: DigestBody;
  logger: Logger;
}) {
  const { deferrals = 0, ...job } = body;
  const resume = await resumeAfterGmailDeferral({
    error,
    path: "/api/ai/digest",
    body: job,
    deferrals,
    jobKey: `digest-${job.emailAccountId}-${job.messageId}`,
    job: "summarizing a digest item",
    logger,
  });
  if (resume !== "unscheduled") return new NextResponse("OK", { status: 200 });

  // Nothing resumes it on its own, so the transport's retry has to.
  return new NextResponse("Gmail quota deferred", {
    status: 503,
    headers: { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
  });
}
