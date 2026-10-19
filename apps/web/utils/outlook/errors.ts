// Helper functions for checking Microsoft Graph API errors
import { extractErrorInfo } from "@/utils/outlook/retry";

/**
 * Check if an error indicates that a resource already exists
 * (e.g., filter, category, etc.)
 */
export function isAlreadyExistsError(error: unknown): boolean {
  // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
  const errorMessage = (error as any)?.message || "";
  return (
    errorMessage.includes("already exists") ||
    errorMessage.includes("duplicate") ||
    errorMessage.includes("conflict")
  );
}

/**
 * Check if a Microsoft Graph API error indicates a resource was not found.
 * GraphError from the SDK has `statusCode: number` as the canonical HTTP status.
 * Microsoft Graph also nests errors under `error` property with code like "itemNotFound".
 */
export function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object") {
    // Check top-level statusCode (GraphError)
    if ("statusCode" in error) {
      return (error as { statusCode: number }).statusCode === 404;
    }
    // Check nested error.code (Microsoft Graph API response format)
    if (
      "error" in error &&
      typeof (error as { error: unknown }).error === "object"
    ) {
      const nestedError = (error as { error: { code?: string } }).error;
      return nestedError?.code === "itemNotFound";
    }
  }
  return false;
}

export function isPreconditionFailedError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "statusCode" in error &&
    (error as { statusCode: unknown }).statusCode === 412
  );
}

const MESSAGE_TOO_LARGE_CODES = new Set([
  "ErrorMessageSizeExceeded",
  "ErrorAttachmentSizeLimitExceeded",
]);

/** Graph refuses a message over the mailbox or tenant size limit before sending it. */
export function isMessageTooLargeError(error: unknown): boolean {
  const { status, code } = extractErrorInfo(error);
  return (
    status === 413 || (code !== undefined && MESSAGE_TOO_LARGE_CODES.has(code))
  );
}
