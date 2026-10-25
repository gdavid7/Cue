import { isOutlookItemNotFoundError } from "@/utils/error";
import { extractErrorInfo as extractGmailErrorInfo } from "@/utils/gmail/retry";
import { extractErrorInfo as extractOutlookErrorInfo } from "@/utils/outlook/retry";

/**
 * Whether the provider rejected an operation because the thread is gone, so
 * callers can tell "already handled" apart from a real failure.
 */
export function isThreadNotFoundError(error: unknown): boolean {
  if (isOutlookItemNotFoundError(error)) return true;

  return (
    error instanceof Error &&
    error.message.includes("Requested entity was not found")
  );
}

/**
 * Whether a background job's conversation is gone, so retrying it can never
 * succeed.
 */
export function isMissingConversation(error: unknown) {
  return (
    extractGmailErrorInfo(error).status === 404 ||
    extractOutlookErrorInfo(error).status === 404
  );
}
