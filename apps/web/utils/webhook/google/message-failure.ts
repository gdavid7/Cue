import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import { isInvalidGrantError } from "@/utils/error";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { isMessageLockUnavailableError } from "@/utils/redis/message-processing";
import { isTransientMessageProcessingError } from "@/utils/webhook/message-processing-failure";

/**
 * Whether a Gmail history run stops before a message that failed, so the
 * cursor stays and a catch-up processes it again, rather than moving past it.
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
