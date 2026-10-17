import { Prisma } from "@/generated/prisma/client";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { isAutomatedAiCallTimeoutError } from "@/utils/llms/automated-call-bound";
import {
  extractLLMErrorInfo,
  isTransientNetworkError,
} from "@/utils/llms/retry";

// Connection and pool failures, not anything about the query.
const TRANSIENT_PRISMA_CODES = new Set([
  "P1001",
  "P1002",
  "P1008",
  "P1017",
  "P2024",
  "P2028",
  "P2034",
]);

const PROCESSING_FAILED_REASON = "Processing failed";

/**
 * Whether processing a message failed for a reason that may pass on its own,
 * such as an AI provider outage, a timeout, or Redis or the database being
 * unreachable, so trying the message again later can succeed. Anything else,
 * such as a request the provider rejects, would fail the same way again.
 */
export function isTransientMessageProcessingError(error: unknown): boolean {
  if (isAutomatedAiCallTimeoutError(error)) return true;
  if (isTransientNetworkError(error)) return true;
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "UpstashError")
      return true;
    if (error instanceof Prisma.PrismaClientInitializationError) return true;
    if (error instanceof Prisma.PrismaClientKnownRequestError)
      return TRANSIENT_PRISMA_CODES.has(error.code);
  }
  return extractLLMErrorInfo(error).retryable;
}

/**
 * Leaves a visible ERROR result for an incoming message whose rules never
 * ran, unless something was recorded for it already. Best effort: the message
 * is moved past either way.
 */
export async function recordMessageProcessingFailure({
  emailAccountId,
  messageId,
  threadId,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  threadId: string;
  logger: Logger;
}) {
  try {
    const existing = await prisma.executedRule.findFirst({
      where: { emailAccountId, messageId },
      select: { id: true },
    });
    if (existing) return;

    await prisma.executedRule.create({
      data: {
        threadId,
        messageId,
        automated: true,
        status: ExecutedRuleStatus.ERROR,
        reason: PROCESSING_FAILED_REASON,
        emailAccount: { connect: { id: emailAccountId } },
      },
    });
  } catch (error) {
    logger.error("Failed to record message processing failure", { error });
  }
}
