import { toastError } from "@/components/Toast";
import { captureException } from "@/utils/error";
import {
  EMAIL_ACCOUNT_HEADER,
  MICROSOFT_AUTH_EXPIRED_ERROR_CODE,
  NO_REFRESH_TOKEN_ERROR_CODE,
  RECONNECT_REQUIRED_MESSAGE,
} from "@/utils/config";
import {
  isReconnectRequired,
  noteReconnectRequired,
  reconnectRequiredBody,
} from "@/utils/reconnect-required";
import { getPermissionsConsentPath } from "@/utils/permissions-consent";
import {
  getSWRFetchErrorMessage,
  normalizeSWRFetchErrorData,
} from "./swr-error";
import { redirectToSafeUrl } from "@/utils/redirect";
import { isSigningOut, withSigningOutSignal } from "@/utils/signing-out";
import {
  hasUnsavedWorkHold,
  isSessionExpiredErrorBody,
  notifySessionExpired,
  saveUnsavedWorkThen,
  SESSION_EXPIRED_MESSAGE,
} from "@/utils/session-expired";
import { fetchWithSessionRetry } from "@/utils/session-refresh";

// Accounts already offered a reconnect on this page.
const reconnectOffered = new Set<string>();

// https://swr.vercel.app/docs/error-handling#status-code-and-error-object
export const swrFetcher = async (
  url: string,
  init?: RequestInit | undefined,
  emailAccountId?: string | null,
  options?: {
    /**
     * The account on screen. An expired grant on it opens its reconnect page;
     * on any other account (All inboxes reads them all) the page stays.
     */
    viewedEmailAccountId?: string | null;
  },
) => {
  if (isSigningOut()) return leaving();

  // The account was already offered a reconnect; asking again only repeats
  // the refusal.
  if (emailAccountId && isReconnectRequired(emailAccountId, url)) {
    // The first refusal may have come while another account was on screen.
    promptReconnect(emailAccountId, options?.viewedEmailAccountId);
    throw reconnectRequiredError();
  }

  const headers = new Headers(init?.headers);

  if (emailAccountId) {
    headers.set(EMAIL_ACCOUNT_HEADER, emailAccountId);
  }

  const newInit = {
    ...init,
    headers,
    signal: withSigningOutSignal(init?.signal),
  };

  let res: Response;
  try {
    res = await fetchWithSessionRetry(url, newInit);
  } catch (error) {
    if (isSigningOut()) return leaving();
    throw error;
  }

  // The session may have ended under a request already on its way.
  if (!res.ok && isSigningOut()) return leaving();

  if (!res.ok) {
    // Try to parse JSON, but handle cases where response isn't JSON (e.g. HMR 404s)
    let errorData: Record<string, unknown> = {};
    try {
      const payload: unknown = await res.json();
      errorData = normalizeSWRFetchErrorData(payload);
    } catch {
      // Response wasn't JSON - common during dev HMR, unexpected in production
      if (process.env.NODE_ENV !== "development") {
        console.error("Failed to parse error response as JSON", {
          url,
          status: res.status,
          statusText: res.statusText,
        });
      }
    }

    if (
      errorData.errorCode === NO_REFRESH_TOKEN_ERROR_CODE ||
      errorData.errorCode === MICROSOFT_AUTH_EXPIRED_ERROR_CODE
    ) {
      if (emailAccountId) {
        noteReconnectRequired(emailAccountId, url);
        const errorMessage =
          errorData.errorCode === MICROSOFT_AUTH_EXPIRED_ERROR_CODE
            ? "Microsoft authorization expired"
            : "Refresh token missing";

        captureException(new Error(errorMessage), {
          extra: {
            url,
            status: res.status,
            statusText: res.statusText,
            responseBody: errorData,
            emailAccountId,
          },
        });

        if (promptReconnect(emailAccountId, options?.viewedEmailAccountId)) {
          console.log(`${errorMessage}, redirecting to consent page...`);
          return;
        }
      }
    }

    const sessionExpired = isSessionExpiredErrorBody(errorData);
    if (sessionExpired) notifySessionExpired();

    const errorMessage = sessionExpired
      ? SESSION_EXPIRED_MESSAGE
      : getSWRFetchErrorMessage(errorData);
    const error: Error & {
      info?: Record<string, unknown>;
      status?: number;
      retryAfterMs?: number;
    } = new Error(errorMessage);

    // Attach extra info to the error object.
    error.info = errorData;
    error.status = res.status;
    error.retryAfterMs = parseRetryAfterMs(res.headers.get("Retry-After"));

    const isKnownError = errorData.isKnownError;

    if (!isKnownError) {
      captureException(error, {
        extra: {
          url,
          status: res.status,
          statusText: res.statusText,
          responseBody: error.info,
          extraMessage: "SWR fetch error",
        },
      });
    }

    throw error;
  }

  return res.json();
};

function reconnectRequiredError() {
  const info = reconnectRequiredBody();
  return Object.assign(new Error(info.error), { info, status: 401 });
}

/** Never settles: the page is leaving, so there is nothing to report. */
function leaving(): Promise<never> {
  return new Promise(() => {});
}

/**
 * A server action found a mailbox grant gone, but its result names no account.
 * The refusal marks the account disconnected, so the account list says which.
 */
export function promptReconnectForDisconnected(
  accounts: ReadonlyArray<{
    id: string;
    account: { disconnectedAt: string | null };
  }>,
  viewedEmailAccountId: string | null | undefined,
) {
  for (const { id, account } of accounts) {
    if (account.disconnectedAt) promptReconnect(id, viewedEmailAccountId);
  }
}

/**
 * Sends the account on screen to its reconnect page; offers it for any other.
 * While a composer is open the viewed account is offered too, so leaving never
 * takes what the user is typing.
 */
function promptReconnect(
  emailAccountId: string,
  viewedEmailAccountId: string | null | undefined,
) {
  const reconnectUrl = getPermissionsConsentPath(emailAccountId, {
    expired: true,
  });
  const viewed = emailAccountId === viewedEmailAccountId;
  if (viewed && !hasUnsavedWorkHold()) {
    redirectToSafeUrl(reconnectUrl);
    return true;
  }
  offerReconnect(emailAccountId, reconnectUrl, viewed);
  return false;
}

function offerReconnect(
  emailAccountId: string,
  reconnectUrl: string,
  viewed: boolean,
) {
  if (reconnectOffered.has(emailAccountId)) return;
  reconnectOffered.add(emailAccountId);
  const action = {
    label: "Reconnect",
    onClick: () => saveUnsavedWorkThen(() => redirectToSafeUrl(reconnectUrl)),
  };
  if (viewed) {
    toastError({
      id: `reconnect-${emailAccountId}`,
      description: RECONNECT_REQUIRED_MESSAGE,
      duration: Number.POSITIVE_INFINITY,
      action,
    });
    return;
  }
  toastError({
    id: `reconnect-${emailAccountId}`,
    title: "One of your inboxes needs reconnecting",
    description:
      "Cue lost access to it, so its mail may be missing. Your other inboxes still work.",
    duration: 30_000,
    action,
  });
}

// Retry-After is either whole seconds or an HTTP date; anything else (a
// negative number, garbage) is no hint at all. The retry bounds the result.
function parseRetryAfterMs(value: string | null): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  if (/^[+-]?[\d.]+$/.test(trimmed)) return;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return;
  return Math.max(0, date - Date.now());
}
