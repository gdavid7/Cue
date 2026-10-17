import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import { isInvalidGrantError } from "@/utils/error";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { isMessageLockUnavailableError } from "@/utils/redis/message-processing";
import { isTransientMessageProcessingError } from "@/utils/webhook/message-processing-failure";

/** A message that failed earlier and isn't due to be retried yet. */
export type MessageRetryPending = { retryPendingUntil: number };

export function isMessageRetryPending(
  outcome: unknown,
): outcome is MessageRetryPending {
  return (
    typeof outcome === "object" &&
    outcome !== null &&
    "retryPendingUntil" in outcome
  );
}

/**
 * Whether a Gmail history run leaves a message that failed before its cursor,
 * so a later run processes it again, rather than moving past it.
 * The message's lock is released for that catch-up.
 */
export function isRetryableGmailMessageFailure(error: unknown) {
  return isGmailRunStopError(error) || isTransientMessageProcessingError(error);
}

/**
 * Failures that hold the whole account back until they pass: Gmail refusing
 * or the quota gate deferring calls, Redis unable to claim messages, or a
 * revoked grant, which fails every message after it too. Any other failure
 * that should pass is only retried for so long.
 */
export function isGmailRunStopError(error: unknown) {
  return (
    isEmailProviderRateLimitError({ error, provider: "google" }) ||
    isGmailCallDeferredError(error) ||
    isMessageLockUnavailableError(error) ||
    isInvalidGrantError(error)
  );
}
