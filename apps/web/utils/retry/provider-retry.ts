import pRetry, { type RetryContext } from "p-retry";
import type { Logger } from "@/utils/logger";
import { getRequestDeadline } from "@/utils/request-deadline-reader";
import { sleep } from "@/utils/sleep";

// "rate-limit-only" is for non-idempotent writes: network, server, and conflict
// failures are ambiguous because the write may already have succeeded.
export type ProviderRetryPolicy = "all" | "rate-limit-only";

interface ProviderRetryDecision {
  delayMs: number;
  /** An outcome callers handle themselves, rethrown without a warning. */
  expected?: boolean;
  isRateLimit: boolean;
  logFields: Record<string, unknown>;
  retryable: boolean;
}

export async function withProviderRetry<T>(
  operation: () => Promise<T>,
  {
    classify,
    logger,
    maxBlockingDelayMs,
    maxRetries,
    providerName,
    retryPolicy,
  }: {
    classify: (attempt: RetryContext) => ProviderRetryDecision;
    logger: Logger;
    maxBlockingDelayMs: number;
    maxRetries: number;
    providerName: string;
    retryPolicy: ProviderRetryPolicy;
  },
): Promise<T> {
  return pRetry(operation, {
    retries: maxRetries,
    // The callback below waits each provider's own backoff; p-retry's default
    // backoff would double it.
    minTimeout: 0,
    onFailedAttempt: async (attempt) => {
      const { retryable, isRateLimit, delayMs, logFields, expected } =
        classify(attempt);
      if (expected) throw attempt.error;

      if (!retryable || (retryPolicy === "rate-limit-only" && !isRateLimit)) {
        logger.warn("Non-retryable error encountered", {
          error: attempt.error,
          ...logFields,
          retryPolicy,
        });
        // Throwing the attempt context would hand callers p-retry's wrapper
        // instead of the provider error, so error classifiers would never match.
        throw attempt.error;
      }

      const retryLogFields = {
        delaySeconds: Math.ceil(delayMs / 1000),
        maxBlockingDelaySeconds: Math.ceil(maxBlockingDelayMs / 1000),
        attemptNumber: attempt.attemptNumber,
        maxRetries,
        ...logFields,
        retryPolicy,
      };

      if (attempt.retriesLeft === 0) {
        logger.warn(`${providerName} error. Out of retries`, retryLogFields);
        throw attempt.error;
      }

      logger.warn(`${providerName} error. Will retry`, retryLogFields);

      if (delayMs > maxBlockingDelayMs) {
        logger.warn(
          "Aborting retry due to long backoff in serverless",
          retryLogFields,
        );
        throw attempt.error;
      }

      const deadlineAt = getRequestDeadline();
      if (deadlineAt !== undefined && Date.now() + delayMs > deadlineAt) {
        logger.warn("Aborting retry that would pass the request deadline", {
          ...retryLogFields,
          remainingMs: Math.max(0, deadlineAt - Date.now()),
        });
        throw attempt.error;
      }

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    },
  });
}

/**
 * Parses a Retry-After header given as delta-seconds or an HTTP-date.
 * Returns undefined when the header is missing, unparseable, or already in the
 * past, so callers can fall back to their own backoff.
 */
export function getRetryAfterDelayMs(
  retryAfterHeader: string | undefined,
): number | undefined {
  if (!retryAfterHeader) return;

  const retryAfterSeconds = Number.parseInt(retryAfterHeader, 10);
  if (!Number.isNaN(retryAfterSeconds)) return retryAfterSeconds * 1000;

  const retryDate = new Date(retryAfterHeader);
  if (Number.isNaN(retryDate.getTime())) return;

  const delayMs = retryDate.getTime() - Date.now();
  return delayMs > 0 ? delayMs : undefined;
}
