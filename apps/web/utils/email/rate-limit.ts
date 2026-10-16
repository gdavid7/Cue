import "server-only";
import type { Logger } from "@/utils/logger";
import {
  getProviderFromRateLimitApiErrorType,
  getProviderRateLimitMessageLabel,
  type EmailProviderRateLimitProvider,
  isProviderRateLimitModeError,
  ProviderRateLimitModeError,
  toRateLimitProvider,
} from "@/utils/email/rate-limit-mode-error";
import {
  getEmailProviderRateLimitStateFromRedis,
  isEmailProviderRateLimitRedisConfigured,
  setEmailProviderRateLimitStateInRedis,
} from "@/utils/redis/email-provider-rate-limit";
import {
  calculateRetryDelay,
  extractErrorInfo,
  isRetryableError,
} from "@/utils/gmail/retry";
import {
  calculateRetryDelay as calculateOutlookRetryDelay,
  extractErrorInfo as extractOutlookErrorInfo,
  isRetryableError as isOutlookRetryableError,
} from "@/utils/outlook/retry";
import { getRetryAfterHeaderFromError } from "@/utils/retry/get-retry-after-header";
import {
  currentGmailQuotaContext,
  getGmailCallDeferredError,
  noteRateLimitModeSkip,
} from "@/utils/gmail/quota";

const DEFAULT_RATE_LIMIT_DELAY_MS = 30_000;
// Gmail's weighted-units quota is a per-minute budget, so a retry within
// seconds only spends units that are not back yet and extends the outage.
const GMAIL_PER_MINUTE_QUOTA_MIN_DELAY_MS = 30_000;
const RETRY_AT_BUFFER_SECONDS = 5;

export type EmailProviderRateLimitState = {
  provider: EmailProviderRateLimitProvider;
  retryAt: Date;
  source?: string;
};

export async function getEmailProviderRateLimitState({
  emailAccountId,
  logger: customLogger,
}: {
  emailAccountId: string;
  logger?: Logger;
}) {
  try {
    return await getEmailProviderRateLimitStateFromRedis({
      emailAccountId,
    });
  } catch (error) {
    customLogger?.warn("Failed to read provider rate-limit state", {
      emailAccountId,
      error: error instanceof Error ? error.message : error,
    });
    return null;
  }
}

export async function recordRateLimitFromApiError({
  apiErrorType,
  error,
  emailAccountId,
  logger,
  source,
}: {
  apiErrorType: string;
  error: unknown;
  emailAccountId?: string;
  logger: Logger;
  source?: string;
}) {
  const provider = getProviderFromRateLimitApiErrorType(apiErrorType);
  if (!provider || !emailAccountId) return null;

  try {
    await recordProviderRateLimitFromError({
      error,
      emailAccountId,
      provider,
      logger,
      source,
    });
  } catch (recordError) {
    logger.warn("Failed to record provider rate-limit state", {
      provider,
      error: recordError instanceof Error ? recordError.message : recordError,
    });
  }

  return provider;
}

type RateLimitRecordingContext = {
  emailAccountId?: string;
  provider?: string | null;
  source?: string;
  logger: Logger;
  attemptNumber?: number;
  onRateLimitRecorded?: (
    state: EmailProviderRateLimitState | null,
    error: unknown,
  ) => void | Promise<void>;
};

export async function setEmailProviderRateLimitState({
  emailAccountId,
  provider,
  retryAt,
  source,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProviderRateLimitProvider;
  retryAt: Date;
  source?: string;
  logger: Logger;
}): Promise<EmailProviderRateLimitState> {
  if (!logger) {
    throw new Error(
      "setEmailProviderRateLimitState requires a request-scoped logger",
    );
  }

  if (!isEmailProviderRateLimitRedisConfigured()) {
    return {
      provider,
      retryAt,
      source,
    };
  }

  let existing: EmailProviderRateLimitState | null = null;
  try {
    existing = await getEmailProviderRateLimitStateFromRedis({
      emailAccountId,
    });
  } catch (error) {
    logger.warn("Failed to read existing provider rate-limit state", {
      emailAccountId,
      provider,
      error: error instanceof Error ? error.message : error,
    });
  }

  if (
    existing &&
    existing.provider === provider &&
    existing.retryAt.getTime() >= retryAt.getTime()
  ) {
    return existing;
  }

  const delayMs = Math.max(0, retryAt.getTime() - Date.now());
  const ttlSeconds = Math.max(
    Math.ceil(delayMs / 1000) + RETRY_AT_BUFFER_SECONDS,
    RETRY_AT_BUFFER_SECONDS,
  );

  await setEmailProviderRateLimitStateInRedis({
    emailAccountId,
    provider,
    retryAt,
    source,
    ttlSeconds,
  });

  logger.warn("Set provider rate-limit mode", {
    emailAccountId,
    provider,
    retryAt: retryAt.toISOString(),
    source,
    ttlSeconds,
  });

  return {
    provider,
    retryAt,
    source,
  };
}

export async function assertProviderNotRateLimited({
  emailAccountId,
  provider,
  logger,
  source,
}: {
  emailAccountId: string;
  provider: EmailProviderRateLimitProvider;
  logger?: Logger;
  source?: string;
}) {
  const state = await getEmailProviderRateLimitState({
    emailAccountId,
    logger,
  });
  if (!state || state.provider !== provider) return;

  noteRateLimitModeSkip();
  logger?.warn("Skipping provider call while rate-limit mode is active", {
    emailAccountId,
    provider,
    retryAt: state.retryAt.toISOString(),
    source,
    rateLimitSource: state.source,
  });

  throw new ProviderRateLimitModeError({
    provider,
    retryAt: state.retryAt,
  });
}

export async function recordProviderRateLimitFromError({
  error,
  emailAccountId,
  provider,
  logger,
  source,
  attemptNumber = 1,
}: {
  error: unknown;
  emailAccountId: string;
  provider: EmailProviderRateLimitProvider;
  logger: Logger;
  source?: string;
  attemptNumber?: number;
}): Promise<EmailProviderRateLimitState | null> {
  if (!isEmailProviderRateLimitRedisConfigured()) return null;
  // A refused background call already paused background work at the Gmail
  // quota gate; account-wide mode would also block the user's own reads.
  if (
    provider === "google" &&
    currentGmailQuotaContext().priority === "background"
  )
    return null;

  const delayMs = getProviderRateLimitDelayMs({
    error,
    provider,
    attemptNumber,
  });
  if (!delayMs) return null;

  const retryAt = new Date(Date.now() + delayMs);
  return setEmailProviderRateLimitState({
    emailAccountId,
    provider,
    retryAt,
    source,
    logger,
  });
}

export async function withRateLimitRecording<T>(
  {
    emailAccountId,
    provider,
    source,
    logger,
    attemptNumber = 1,
    onRateLimitRecorded,
  }: RateLimitRecordingContext,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    let rateLimitState: EmailProviderRateLimitState | null = null;
    const rateLimitProvider = toRateLimitProvider(provider);
    if (emailAccountId && rateLimitProvider) {
      try {
        rateLimitState = await recordProviderRateLimitFromError({
          error,
          emailAccountId,
          provider: rateLimitProvider,
          logger,
          source,
          attemptNumber,
        });
      } catch (recordError) {
        logger.warn("Failed to record provider rate-limit state", {
          provider: rateLimitProvider,
          source,
          error:
            recordError instanceof Error ? recordError.message : recordError,
        });
      }
    }
    if (onRateLimitRecorded) {
      await onRateLimitRecorded(rateLimitState, error);
    }
    throw error;
  }
}

/**
 * A sentence an assistant can repeat to the user when a provider call failed
 * because the provider (or Cue's per-account budget for it) is limiting
 * requests; null for any other failure.
 */
export function describeProviderRateLimitError(
  error: unknown,
  provider: string,
): string | null {
  const rateLimitProvider = toRateLimitProvider(provider);
  if (!rateLimitProvider) return null;
  let delayMs: number | null;
  if (isProviderRateLimitModeError(error)) {
    const retryAt = error.retryAt ? Date.parse(error.retryAt) : Number.NaN;
    delayMs = Number.isNaN(retryAt)
      ? DEFAULT_RATE_LIMIT_DELAY_MS
      : retryAt - Date.now();
  } else {
    delayMs =
      getGmailCallDeferredError(error)?.retryAfterMs ??
      getProviderRateLimitDelayMs({
        error,
        provider: rateLimitProvider,
        attemptNumber: 1,
      });
  }
  if (delayMs === null) return null;
  const seconds = Math.max(1, Math.ceil(delayMs / 1000));
  return `${getProviderRateLimitMessageLabel(rateLimitProvider)} is temporarily limiting requests; try again in about ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

/** How long a client should wait before retrying what a provider refused. */
export function getProviderRateLimitRetryAfterSeconds(
  error: unknown,
  provider: EmailProviderRateLimitProvider,
): number | undefined {
  const delayMs = isProviderRateLimitModeError(error)
    ? Date.parse(error.retryAt ?? "") - Date.now()
    : getProviderRateLimitDelayMs({ error, provider, attemptNumber: 1 });
  if (!delayMs || !(delayMs > 0)) return;
  return Math.ceil(delayMs / 1000);
}

export function getProviderRateLimitDelayMs({
  error,
  provider,
  attemptNumber,
}: {
  error: unknown;
  provider: EmailProviderRateLimitProvider;
  attemptNumber: number;
}) {
  // The guard's own error is not a provider response. Recording it would
  // push retryAt forward on every skipped call, so the mode never expires.
  if (isProviderRateLimitModeError(error)) return null;

  if (provider === "google") {
    return getGoogleRateLimitDelayMs(error, attemptNumber);
  }

  return getMicrosoftRateLimitDelayMs(error, attemptNumber);
}

function getGoogleRateLimitDelayMs(error: unknown, attemptNumber: number) {
  return calculateProviderRateLimitDelay({
    error,
    attemptNumber,
    extractErrorInfo,
    isRateLimitError: (errorInfo) => isRetryableError(errorInfo).isRateLimit,
    calculateDelayMs: ({ attemptNumber, retryAfterHeader, errorInfo }) => {
      const delayMs = calculateRetryDelay(
        true,
        false,
        false,
        attemptNumber,
        retryAfterHeader,
        errorInfo.errorMessage,
      );
      const hasRetryTime =
        retryAfterHeader !== undefined ||
        /Retry after /i.test(errorInfo.errorMessage);
      if (hasRetryTime || !/per minute/i.test(errorInfo.errorMessage)) {
        return delayMs;
      }
      return Math.max(delayMs, GMAIL_PER_MINUTE_QUOTA_MIN_DELAY_MS);
    },
  });
}

function getMicrosoftRateLimitDelayMs(error: unknown, attemptNumber: number) {
  return calculateProviderRateLimitDelay({
    error,
    attemptNumber,
    extractErrorInfo: extractOutlookErrorInfo,
    isRateLimitError: (errorInfo) =>
      isOutlookRetryableError(errorInfo).isRateLimit,
    calculateDelayMs: ({ attemptNumber, retryAfterHeader }) =>
      calculateOutlookRetryDelay(
        true,
        false,
        false,
        attemptNumber,
        retryAfterHeader,
      ),
  });
}

function calculateProviderRateLimitDelay<TErrorInfo>({
  error,
  attemptNumber,
  extractErrorInfo,
  isRateLimitError,
  calculateDelayMs,
}: {
  error: unknown;
  attemptNumber: number;
  extractErrorInfo: (error: unknown) => TErrorInfo;
  isRateLimitError: (errorInfo: TErrorInfo) => boolean;
  calculateDelayMs: (options: {
    attemptNumber: number;
    retryAfterHeader?: string;
    errorInfo: TErrorInfo;
  }) => number;
}): number | null {
  const errorInfo = extractErrorInfo(error);
  if (!isRateLimitError(errorInfo)) return null;

  const retryAfterHeader = getRetryAfterHeaderFromError(error);
  const delayMs = calculateDelayMs({
    attemptNumber,
    retryAfterHeader,
    errorInfo,
  });

  return delayMs > 0 ? delayMs : DEFAULT_RATE_LIMIT_DELAY_MS;
}
