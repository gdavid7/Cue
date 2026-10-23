import {
  captureException as sentryCaptureException,
  setUser,
} from "@sentry/nextjs";
import { AISDKError, APICallError } from "@ai-sdk/provider";
import type { NoObjectGeneratedError, RetryError } from "ai";
import type { FlattenedValidationErrors } from "next-safe-action";
import {
  type EmailProviderRateLimitProvider,
  getProviderRateLimitApiErrorType,
  getProviderRateLimitMessageLabel,
  isProviderRateLimitModeError,
} from "@/utils/email/rate-limit-mode-error";
import { extractErrorInfo } from "@/utils/gmail/retry";
import { createScopedLogger, type Logger } from "@/utils/logger";
import {
  notifySessionExpired,
  SESSION_EXPIRED_MESSAGE,
} from "@/utils/session-expired";

// biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
export type ErrorMessage = { error: string; data?: any };
export type ZodError = {
  error: { issues: { code: string; message: string }[] };
};
export type ApiErrorType = {
  type: string;
  message?: string;
  code: number;
};

const RATE_LIMIT_MESSAGE_TEMPLATE =
  "{provider} is temporarily limiting requests. Please try again shortly.";
export const EMAIL_PROVIDER_RATE_LIMIT_MESSAGE =
  "Your email provider is temporarily limiting requests. Please try again shortly.";
export const UNEXPECTED_ACTION_ERROR_MESSAGE = "An unknown error occurred.";

export function getEmailProviderRateLimitMessage(
  provider: EmailProviderRateLimitProvider,
) {
  return RATE_LIMIT_MESSAGE_TEMPLATE.replace(
    "{provider}",
    getProviderRateLimitMessageLabel(provider),
  );
}

// biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
export function isError(value: any): value is ErrorMessage | ZodError {
  return value?.error;
}

export function isGmailError(
  error: unknown,
): error is { code: number; errors: { message: string }[] } {
  return (
    typeof error === "object" &&
    error !== null &&
    // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
    Array.isArray((error as any).errors) &&
    // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
    (error as any).errors.length > 0
  );
}

export type CaptureExceptionContext = {
  // emailAccountId is set automatically via:
  // - Frontend: SentryIdentify component
  // - API routes: emailAccountMiddleware
  // - Server actions: actionClient
  // Only pass explicitly for code outside these contexts (e.g., cron jobs).
  emailAccountId?: string | null;
  userId?: string | null;
  userEmail?: string;
  // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
  extra?: Record<string, any>;
  sampleRate?: number;
};

export type LlmRepairMetadata = {
  attempted: true;
  successful: boolean;
  label: string;
  provider: string;
  model: string;
  inputLength: number;
  inputFingerprint: string;
  startsWithQuote: boolean;
  startsWithBrace: boolean;
  startsWithBracket: boolean;
  looksCodeFenced: boolean;
  candidateKindsTried: string[];
  successfulCandidateKind?: string;
};

const LLM_REPAIR_METADATA_KEY = "__llmRepairMetadata";

export function attachLlmRepairMetadata(
  error: unknown,
  metadata: LlmRepairMetadata | undefined,
) {
  if (!metadata || typeof error !== "object" || error === null) return;

  const target = error as Record<string, unknown>;

  // Diagnostic metadata must never turn the original model error into a
  // webhook-processing failure for frozen or otherwise immutable errors.
  if (!Object.isExtensible(target)) return;

  try {
    target[LLM_REPAIR_METADATA_KEY] = metadata;
  } catch {
    return;
  }
}

export function captureException(
  error: unknown,
  context: CaptureExceptionContext = {},
) {
  if (isKnownApiError(error) || isHandledUserKeyError(error)) {
    const logger = createScopedLogger("captureException");
    logger.warn("Known API error", { error, context });
    return;
  }

  const { sampleRate, userEmail, emailAccountId, userId, extra } = context;
  if (
    Number.isFinite(sampleRate) &&
    process.env.NODE_ENV === "production" &&
    Math.random() >= (sampleRate as number)
  ) {
    return;
  }

  if (userEmail) setUser({ email: userEmail });

  const llmRepair = getLlmRepairMetadata(error);
  const sentryExtra = {
    ...extra,
    ...(llmRepair ? { llmRepair } : {}),
    ...(emailAccountId && { emailAccountId }),
    ...(userId && { userId }),
  };

  sentryCaptureException(error, {
    extra: Object.keys(sentryExtra).length > 0 ? sentryExtra : undefined,
  });
}

function getLlmRepairMetadata(error: unknown): LlmRepairMetadata | undefined {
  if (typeof error !== "object" || error === null) return;

  const metadata = (error as Record<string, unknown>)[LLM_REPAIR_METADATA_KEY];
  if (!metadata || typeof metadata !== "object") return;

  return metadata as LlmRepairMetadata;
}

export type ActionError<E extends object = Record<string, unknown>> = {
  error: string;
} & E;
export type ServerActionResponse<
  T,
  E extends object = Record<string, unknown>,
> = ActionError<E> | T;

// This class is used to throw error messages that are safe to expose to the client.
export class SafeError extends Error {
  safeMessage?: string;
  statusCode?: number;

  constructor(safeMessage?: string, statusCode?: number) {
    super(safeMessage);
    this.name = "SafeError";
    this.safeMessage = safeMessage;
    this.statusCode = statusCode;
  }
}

export const NO_REFRESH_TOKEN_MESSAGE = "No refresh token";

/**
 * A mail client found the account's grant gone and the account already marked
 * as needing a reconnect. Expected for a revoked or disconnected account, not
 * a failure. Calendar clients throw a plain SafeError with the same message.
 */
export class ReconnectRequiredError extends SafeError {
  constructor() {
    super(NO_REFRESH_TOKEN_MESSAGE);
    this.name = "ReconnectRequiredError";
  }
}

export function isReconnectRequiredError(error: unknown) {
  return error instanceof ReconnectRequiredError;
}

export class DraftNotFoundError extends SafeError {
  constructor(safeMessage: string) {
    super(safeMessage);
    this.name = "DraftNotFoundError";
  }
}

export class EmailProviderRateLimitError extends Error {
  constructor() {
    super(EMAIL_PROVIDER_RATE_LIMIT_MESSAGE);
    this.name = "EmailProviderRateLimitError";
  }
}

const INVALID_GRANT_ERROR_MARKERS = ["invalid_grant", "AADSTS50173"] as const;

export function isInvalidGrantError(error: unknown): boolean {
  const message = getErrorMessage(error);
  if (
    message &&
    INVALID_GRANT_ERROR_MARKERS.some((marker) => message.includes(marker))
  ) {
    return true;
  }

  // A refresh failure may be rethrown as a reconnect error wrapping it.
  const cause = error instanceof Error ? error.cause : undefined;
  return cause !== undefined && cause !== error && isInvalidGrantError(cause);
}

export function isGmailInsufficientPermissionsError(error: unknown): boolean {
  // gaxios 7 puts the API's `errors` array on `cause`.
  return extractErrorInfo(error).reason === "insufficientPermissions";
}

export function isGmailRateLimitExceededError(error: unknown): boolean {
  const errorInfo = extractErrorInfo(error);
  return (
    errorInfo.reason === "rateLimitExceeded" ||
    errorInfo.reason === "userRateLimitExceeded" ||
    /user-rate limit exceeded/i.test(errorInfo.errorMessage)
  );
}

export function isGmailQuotaExceededError(error: unknown): boolean {
  return extractErrorInfo(error).reason === "quotaExceeded";
}

export function isIncorrectAPIKeyError(error: APICallError): boolean {
  return (
    error.message.includes("Incorrect API key provided") ||
    error.statusCode === 401
  );
}

export function isInvalidAIModelError(error: APICallError): boolean {
  const message = error.message.toLowerCase();

  // OpenAI: "The model `xyz` does not exist or you do not have access to it"
  if (
    error.message.includes("does not exist or you do not have access to it")
  ) {
    return true;
  }
  // Anthropic: 404 with "not_found_error"
  if (error.statusCode === 404 && error.message.includes("not_found_error")) {
    return true;
  }
  // Bedrock: error message is just the model ID (e.g., "model: anthropic.claude-...")
  if (/^model:\s*\S+$/.test(error.message.trim())) {
    return true;
  }
  // OpenRouter: model deprecated or unavailable
  if (
    message.includes("testing period") ||
    message.includes("is deprecated") ||
    message.includes("no endpoints found for") ||
    message.includes("is not a valid model id")
  ) {
    return true;
  }
  // Google: retired model, e.g. "This model models/xyz is no longer available"
  if (/\bmodel\b.*\bis no longer available\b/.test(message)) {
    return true;
  }
  // Generic model-not-found patterns
  if (
    error.message.includes("model is not available") ||
    error.message.includes("model not found")
  ) {
    return true;
  }
  return false;
}

export function isAPIKeyDeactivatedError(error: APICallError): boolean {
  return error.message.includes("this API key has been deactivated");
}

export function isAnthropicInsufficientBalanceError(
  error: APICallError,
): boolean {
  return error.message.includes(
    "Your credit balance is too low to access the Anthropic API",
  );
}

// The Anthropic account is out of prepaid credit, or over its tier's monthly
// spend cap or a spend limit set in the Console. Retrying fails until billing
// changes, but another provider can still answer.
export function isAnthropicBillingLimitError(error: APICallError): boolean {
  return (
    isAnthropicInsufficientBalanceError(error) ||
    error.message.includes("You have reached your specified") ||
    getProviderErrorCode(error) === "enforced_spend_limit_reached"
  );
}

export function isInsufficientCreditsError(error: APICallError): boolean {
  // OpenAI reports an exhausted balance as a 429 with this error type.
  return (
    error.statusCode === 402 ||
    getProviderErrorType(error) === "insufficient_quota"
  );
}

// Retries wrap the provider's error, which carries the status and body.
export function getAIApiCallError(error: unknown): APICallError | null {
  if (APICallError.isInstance(error)) return error;
  if (isRetryError(error) && APICallError.isInstance(error.lastError))
    return error.lastError;
  return null;
}

const HANDLED_USER_KEY_ERROR = "__handledUserKeyError";

export function markAsHandledUserKeyError(error: unknown): void {
  if (typeof error !== "object" || error === null) return;
  (error as Record<string, unknown>)[HANDLED_USER_KEY_ERROR] = true;
}

export function isHandledUserKeyError(error: unknown): boolean {
  return (error as Record<string, unknown>)?.[HANDLED_USER_KEY_ERROR] === true;
}

// Handling AI quota/retry errors. This can be related to the user's own API quota or the system's quota.
export function isAiQuotaExceededError(error: RetryError): boolean {
  if (
    APICallError.isInstance(error.lastError) &&
    isInsufficientCreditsError(error.lastError)
  ) {
    return true;
  }

  const message = [error.message, getErrorMessage(error.lastError)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const quotaErrorMessages = [
    "exceeded your current quota",
    "quota exceeded",
    "rate limit reached",
    "rate_limit_reached",
    "too many requests",
    "hit a rate limit",
  ];
  return quotaErrorMessages.some((substr) => message.includes(substr));
}

export function isOutlookThrottlingError(error: unknown): boolean {
  // The app's own limits throw a SafeError with a 429; only Graph throttles the mailbox.
  if (error instanceof SafeError) return false;
  const err = error as Record<string, unknown>;
  const code = err?.code as string | undefined;
  const statusCode = err?.statusCode as number | undefined;
  const message = err?.message as string | undefined;
  return (
    statusCode === 429 ||
    code === "ApplicationThrottled" ||
    code === "TooManyRequests" ||
    (typeof message === "string" &&
      (/MailboxConcurrency/i.test(message) ||
        message.includes("Request limit")))
  );
}

export function isOutlookAccessDeniedError(error: unknown): boolean {
  const err = error as Record<string, unknown>;
  const code = err?.code as string | undefined;
  const message =
    typeof err?.message === "string" ? err.message : String(err ?? "");
  return (
    code === "ErrorAccessDenied" ||
    code === "AccessDenied" ||
    message.includes("Access is denied. Check credentials and try again")
  );
}

export function isOutlookItemNotFoundError(error: unknown): boolean {
  const err = error as Record<string, unknown>;
  const code = err?.code as string | undefined;
  const message =
    typeof err?.message === "string" ? err.message : String(err ?? "");
  return (
    code === "ErrorItemNotFound" ||
    code === "itemNotFound" ||
    message.includes("not found in the store") ||
    message.includes("ResourceNotFound") ||
    message.includes("isn't an ID of an item")
  );
}

export function isKnownOutlookError(error: unknown): boolean {
  return (
    isOutlookThrottlingError(error) ||
    isOutlookAccessDeniedError(error) ||
    isOutlookItemNotFoundError(error)
  );
}

// Provider content moderation refused to produce structured output. Retrying
// the same model is futile; a fallback model may succeed. Handles p-retry
// context wrappers that expose the real error on an `error` property.
export function isContentFilterRefusal(error: unknown): boolean {
  const unwrapped = (error as { error?: unknown })?.error ?? error;
  return (
    isNoObjectGeneratedError(unwrapped) &&
    unwrapped.finishReason === "content-filter"
  );
}

// we don't want to capture these errors in Sentry
export function isKnownApiError(error: unknown): boolean {
  return (
    isProviderRateLimitModeError(error) ||
    isGmailInsufficientPermissionsError(error) ||
    isGmailRateLimitExceededError(error) ||
    isGmailQuotaExceededError(error) ||
    isKnownOutlookError(error) ||
    isContentFilterRefusal(error) ||
    (APICallError.isInstance(error) &&
      (isIncorrectAPIKeyError(error) ||
        isInvalidAIModelError(error) ||
        isAPIKeyDeactivatedError(error) ||
        isAnthropicInsufficientBalanceError(error))) ||
    (isRetryError(error) && isAiQuotaExceededError(error)) ||
    (error instanceof Error && isKnownAIErrorMessage(error.message))
  );
}

export function checkCommonErrors(
  error: unknown,
  url: string,
  logger: Logger,
): ApiErrorType | null {
  if (isProviderRateLimitModeError(error)) {
    const apiErrorType = getProviderRateLimitApiErrorType(error.provider);
    logger.warn("Provider rate-limit mode active for url", {
      url,
      provider: error.provider,
      retryAt: error.retryAt,
    });
    return {
      type: apiErrorType,
      message: getEmailProviderRateLimitMessage(error.provider),
      code: 429,
    };
  }

  if (isGmailInsufficientPermissionsError(error)) {
    logger.warn("Gmail insufficient permissions error for url", { url });
    return {
      type: "Gmail Insufficient Permissions",
      message:
        "You must grant all Gmail permissions to use the app. Please log out and log in again to grant permissions.",
      code: 403,
    };
  }

  if (isGmailRateLimitExceededError(error)) {
    logger.warn("Gmail rate limit exceeded for url", { url });
    return {
      type: getProviderRateLimitApiErrorType("google"),
      message: getEmailProviderRateLimitMessage("google"),
      code: 429,
    };
  }

  if (isGmailQuotaExceededError(error)) {
    logger.warn("Gmail quota exceeded for url", { url });
    return {
      type: "Gmail Quota Exceeded",
      message: "You have exceeded the Gmail quota. Please try again later.",
      code: 429,
    };
  }

  if (isOutlookThrottlingError(error)) {
    logger.warn("Outlook throttling error for url", { url });
    return {
      type: getProviderRateLimitApiErrorType("microsoft"),
      message: getEmailProviderRateLimitMessage("microsoft"),
      code: 429,
    };
  }

  if (isOutlookAccessDeniedError(error)) {
    logger.warn("Outlook access denied error for url", { url });
    return {
      type: "Outlook Access Denied",
      message:
        "Access to the mailbox was denied. The account may need to be reconnected.",
      code: 403,
    };
  }

  if (isOutlookItemNotFoundError(error)) {
    logger.warn("Outlook item not found for url", { url });
    return {
      type: "Outlook Item Not Found",
      message: "The requested email was not found. It may have been deleted.",
      code: 404,
    };
  }

  if (isRetryError(error) && isAiQuotaExceededError(error)) {
    logger.warn("AI quota exceeded for url", { url });
    return {
      type: "AI Quota Exceeded",
      message: `AI error: ${error.message}`,
      code: 429,
    };
  }

  return null;
}

export function getErrorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;

  const outer = asRecord(error);
  if (!outer) return;

  const directMessage = getStringProp(outer, "message");
  if (directMessage) return directMessage;

  const nested = asRecord(outer.error);
  if (!nested) return;

  return getStringProp(nested, "message");
}

export function getUserFacingErrorMessage(
  error: unknown,
  fallback = "An unexpected error occurred. Please try again.",
): string {
  const message = getErrorMessage(error);
  if (!message) return fallback;

  const parsed = parseJsonRecord(message);
  if (!parsed) return message;

  return getErrorMessage(parsed) || getStringProp(parsed, "error") || message;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function getStringProp(
  obj: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function parseJsonRecord(message: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(message));
  } catch {
    return null;
  }
}

// --- Safe Action Error Handling ---

type FlattenedErrors = FlattenedValidationErrors<Record<string, string[]>>;

type SafeActionError = {
  serverError?: string;
  validationErrors?: FlattenedErrors;
  bindArgsValidationErrors?: readonly (FlattenedErrors | undefined)[];
};

type ActionErrorMessageOptions = {
  fallback?: string;
  prefix?: string;
};

/**
 * Extracts a user-friendly error message from a safe-action error result.
 * Expects flattened validation errors (defaultValidationErrorsShape: "flattened").
 *
 * @param error - The error object from safe-action
 * @param fallbackOrOptions - Either a fallback string, or options object with fallback/prefix
 *
 * @example
 * // Simple usage
 * getActionErrorMessage(error.error)
 *
 * @example
 * // With prefix (shows "Failed to save. <error>" or just "Failed to save" if no error)
 * getActionErrorMessage(error.error, { prefix: "Failed to save" })
 */
export function getActionErrorMessage(
  error: SafeActionError,
  fallbackOrOptions:
    | string
    | ActionErrorMessageOptions = "An unknown error occurred",
): string {
  const { fallback, prefix } =
    typeof fallbackOrOptions === "string"
      ? { fallback: fallbackOrOptions, prefix: undefined }
      : {
          fallback: fallbackOrOptions.fallback ?? "An unknown error occurred",
          prefix: fallbackOrOptions.prefix,
        };

  const message = extractActionErrorMessage(error);

  if (prefix) {
    return message ? `${prefix}. ${message}` : prefix;
  }

  return message || fallback;
}

export function assertActionSucceeded(
  result: SafeActionError | undefined,
): void {
  if (!result) return;

  const message = extractActionErrorMessage(result);
  if (message === EMAIL_PROVIDER_RATE_LIMIT_MESSAGE) {
    throw new EmailProviderRateLimitError();
  }
  if (message) throw new Error(message);
}

function extractActionErrorMessage(error: SafeActionError): string | null {
  if (error.serverError) {
    // Action call sites read their errors through here, so this is the one
    // client-side place that sees an action rejected for a signed-out session.
    if (error.serverError === SESSION_EXPIRED_MESSAGE) notifySessionExpired();
    return error.serverError;
  }

  const messages = getValidationMessages(error.validationErrors);
  if (messages) return messages;

  if (error.bindArgsValidationErrors) {
    for (const ve of error.bindArgsValidationErrors) {
      const msg = getValidationMessages(ve);
      if (msg) return msg;
    }
  }

  return null;
}

function getValidationMessages(
  errors: FlattenedErrors | undefined,
): string | null {
  if (!errors) return null;

  const { formErrors, fieldErrors } = errors;
  const all = [...formErrors, ...Object.values(fieldErrors).flat()];

  return all.length > 0 ? all.join(". ") : null;
}

// Message-based fallback for AI errors that may lose their APICallError type
// (e.g., when wrapped by middleware like PostHog AI)
function isKnownAIErrorMessage(message: string): boolean {
  const patterns = [
    "Incorrect API key provided",
    "does not exist or you do not have access to it",
    "this API key has been deactivated",
    "credit balance is too low",
    "testing period",
    "model is not available",
    "model not found",
  ];
  return patterns.some((p) => message.includes(p));
}

// Every page imports this module to report errors, and importing any value
// from `ai` brings the whole SDK into the browser bundle. Its errors carry the
// markers its own isInstance checks read, so check those here instead.
class AiSdkErrorMarker extends AISDKError {
  static matches(error: unknown, name: string) {
    return AISDKError.hasMarker(error, `vercel.ai.error.${name}`);
  }
}

function isRetryError(error: unknown): error is RetryError {
  return AiSdkErrorMarker.matches(error, "AI_RetryError");
}

function isNoObjectGeneratedError(
  error: unknown,
): error is NoObjectGeneratedError {
  return AiSdkErrorMarker.matches(error, "AI_NoObjectGeneratedError");
}

// Providers' error schemas can drop `details`, so fall back to the raw body.
function getProviderErrorCode(error: APICallError): string | undefined {
  type ErrorBody = { error?: { details?: { error_code?: unknown } } };
  const fromData = (error.data as ErrorBody | undefined)?.error?.details
    ?.error_code;
  if (typeof fromData === "string") return fromData;
  if (!error.responseBody) return;
  try {
    const body = JSON.parse(error.responseBody) as ErrorBody;
    const fromBody = body?.error?.details?.error_code;
    return typeof fromBody === "string" ? fromBody : undefined;
  } catch {
    return;
  }
}

function getProviderErrorType(error: APICallError): string | undefined {
  const data = error.data as { error?: { type?: unknown } } | undefined;
  if (typeof data?.error?.type === "string") return data.error.type;
  if (!error.responseBody) return;
  try {
    const body = JSON.parse(error.responseBody) as {
      error?: { type?: unknown };
    };
    return typeof body?.error?.type === "string" ? body.error.type : undefined;
  } catch {
    return;
  }
}
