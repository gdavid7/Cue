import { extractErrorInfo, isRetryableError } from "@/utils/gmail/retry";
import {
  isProviderRateLimitModeError,
  toRateLimitProvider,
} from "@/utils/email/rate-limit-mode-error";
import { SafeError } from "@/utils/error";
import {
  extractErrorInfo as extractOutlookErrorInfo,
  isRetryableError as isOutlookRetryableError,
} from "@/utils/outlook/retry";

export function isEmailProviderRateLimitError({
  error,
  provider,
}: {
  error: unknown;
  provider?: string | null;
}) {
  if (isProviderRateLimitModeError(error)) return true;
  // The app's own limits throw a SafeError with a 429; only the provider's answer counts.
  if (error instanceof SafeError) return false;

  const rateLimitProvider = toRateLimitProvider(provider);
  if (rateLimitProvider === "google") {
    return isRetryableError(extractErrorInfo(error)).isRateLimit;
  }
  if (rateLimitProvider === "microsoft") {
    return isOutlookRetryableError(extractOutlookErrorInfo(error)).isRateLimit;
  }

  return false;
}
