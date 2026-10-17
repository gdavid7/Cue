import useSWR, {
  SWRConfig,
  type SWRConfiguration,
  type SWRResponse,
} from "swr";
import { EMAIL_ACCOUNT_ID_REQUIRED_ERROR } from "@/utils/config";
import { useAccount } from "@/providers/EmailAccountProvider";
import { isSessionExpiredErrorBody } from "@/utils/session-expired";

// Makes sure that we have an email account id before fetching
// Otherwise the backend will return an error
// biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
export function useSWRWithEmailAccount<Data = any, Error = any>(url: string) {
  const { emailAccountId } = useAccount();
  return useSWR<Data, Error>(emailAccountId ? url : null);
}

// Routes scoped by the authenticated email account need the account in the
// cache key, or an account switch would serve another account's data.
export function getAccountScopedKey(
  path: string,
  emailAccountId?: string | null,
) {
  if (emailAccountId === undefined) return path;

  return emailAccountId ? ([path, emailAccountId] as const) : null;
}

export function shouldResetSwrCacheForAccountId(
  previousEmailAccountId: string | null,
  emailAccountId: string,
) {
  if (!emailAccountId) return false;
  if (previousEmailAccountId === null) return false;
  return previousEmailAccountId !== emailAccountId;
}

// Empty → id must revalidate the live scoped cache, including keys that are
// not persisted (for example a first-paint 403 on /api/user/email-account).
export function shouldRevalidateAllLiveSwrKeysForAccountId(
  previousEmailAccountId: string | null,
  emailAccountId: string,
) {
  return previousEmailAccountId === "" && Boolean(emailAccountId);
}

export function getDevSWRErrorRetryMs(
  error: { status?: number; message?: string },
  retryCount: number,
) {
  if (error.status === 404) return 500;
  // pnpm dev skips other 4xx retries; production still retries, so a missing
  // account header only sticks on the emulator/local settings page.
  if (
    error.status === 403 &&
    error.message === EMAIL_ACCOUNT_ID_REQUIRED_ERROR
  ) {
    return retryCount >= 5 ? null : 500;
  }
  if (error.status && error.status >= 400 && error.status < 500) return null;
  return 5000 * 2 ** retryCount;
}

// A provider rate limit lasts tens of seconds. SWR's default backoff starts at
// five seconds, so each rate-limited request would retry into the same window,
// spending quota the provider has not restored and keeping the account limited.
const RATE_LIMITED_RETRY_MS = 60_000;
// A deferred read (503) says how long the account's budget needs. Waiting it
// out asks once instead of several times inside the window. The bounds keep a
// bad header from either hammering the server or parking the screen, and the
// jitter keeps tabs deferred together from all asking at the same moment.
const MIN_RETRY_AFTER_MS = 1000;
const MAX_RETRY_AFTER_MS = 90_000;

export const onSWRErrorRetry: NonNullable<SWRConfiguration["onErrorRetry"]> = (
  error,
  key,
  config,
  revalidate,
  opts,
) => {
  const hint = getRetryHint(error, opts.retryCount);
  if (hint.kind === "backoff") {
    SWRConfig.defaultValue.onErrorRetry(error, key, config, revalidate, opts);
    return;
  }
  if (hint.kind === "stop") return;
  if (
    config.errorRetryCount !== undefined &&
    opts.retryCount > config.errorRetryCount
  )
    return;
  setTimeout(() => whenVisible(() => revalidate(opts)), hint.ms);
};

type RetryHint =
  | { kind: "wait"; ms: number }
  | { kind: "stop" }
  /** The server gave no hint: use the usual backoff. */
  | { kind: "backoff" };

/**
 * What the server's answer says about the next try. `retryCount` is 1 for the
 * first retry; `jitter` (0.75–1.25) spreads the wait for a Retry-After hint.
 */
export function getRetryHint(
  error: { status?: number; retryAfterMs?: number; info?: unknown } | undefined,
  retryCount: number,
  jitter = 0.75 + Math.random() / 2,
): RetryHint {
  // Retrying cannot restore a signed-out session; the fetcher already asked
  // the user to sign in.
  if (isSessionExpiredErrorBody(error?.info)) return { kind: "stop" };
  if (error?.status === 429)
    return retryCount <= 1
      ? { kind: "wait", ms: RATE_LIMITED_RETRY_MS }
      : { kind: "stop" };
  if (error?.status === 503 && typeof error.retryAfterMs === "number") {
    const bounded = Math.min(
      Math.max(error.retryAfterMs, MIN_RETRY_AFTER_MS),
      MAX_RETRY_AFTER_MS,
    );
    return { kind: "wait", ms: Math.round(bounded * jitter) };
  }
  return { kind: "backoff" };
}

type NormalizedError = { error: string };

/**
 * Processes the result of an SWR hook, normalizing errors.
 * Assumes the API might return an object like { error: string } instead of data on failure.
 *
 * @param swrResult The raw result from the useSWR hook.
 * @returns SWRResponse with data as TData | null and error as NormalizedError | undefined.
 */
export function processSWRResponse<
  TData,
  TApiError extends { error: string } = { error: string }, // Assume API error shape
  TSWRError = Error, // Assume SWR error type
>(
  swrResult: SWRResponse<TData | TApiError, TSWRError>,
): SWRResponse<TData | null, NormalizedError> {
  const swrError = swrResult.error as TSWRError | undefined; // Cast for type checking
  const data = swrResult.data as TData | TApiError | undefined; // Cast for type checking

  // Handle SWR hook error
  if (swrError instanceof Error) {
    return {
      ...swrResult,
      data: null,
      error: { error: swrError.message },
    } as SWRResponse<TData | null, NormalizedError>;
  }
  // Handle potential non-Error SWR errors (less common)
  if (swrError) {
    return {
      ...swrResult,
      data: null,
      error: { error: String(swrError) }, // Convert non-Error to string
    } as SWRResponse<TData | null, NormalizedError>;
  }

  // Handle API error returned within data
  if (
    data &&
    typeof data === "object" &&
    "error" in data &&
    typeof data.error === "string"
  ) {
    return {
      ...swrResult,
      data: null,
      error: { error: data.error },
    } as SWRResponse<TData | null, NormalizedError>;
  }

  // No error found, return the data (might be null/undefined during loading)
  // Cast data to expected type, filtering out the TApiError possibility
  return {
    ...swrResult,
    data: data as TData | null, // SWR handles undefined during load
    error: undefined,
  } as SWRResponse<TData | null, NormalizedError>;
}

// As SWR's own retries: a hidden tab doesn't ask, it asks once it is back.
function whenVisible(run: () => void) {
  if (typeof document === "undefined" || document.visibilityState !== "hidden")
    return run();
  const onChange = () => {
    if (document.visibilityState === "hidden") return;
    document.removeEventListener("visibilitychange", onChange);
    run();
  };
  document.addEventListener("visibilitychange", onChange);
}
