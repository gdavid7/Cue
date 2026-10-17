import { captureException } from "@/utils/error";
import {
  EMAIL_ACCOUNT_HEADER,
  MICROSOFT_AUTH_EXPIRED_ERROR_CODE,
  NO_REFRESH_TOKEN_ERROR_CODE,
} from "@/utils/config";
import { getPermissionsConsentPath } from "@/utils/permissions-consent";
import {
  getSWRFetchErrorMessage,
  normalizeSWRFetchErrorData,
} from "./swr-error";
import { redirectToSafeUrl } from "@/utils/redirect";
import {
  isSessionExpiredErrorBody,
  notifySessionExpired,
  SESSION_EXPIRED_MESSAGE,
} from "@/utils/session-expired";

// https://swr.vercel.app/docs/error-handling#status-code-and-error-object
export const swrFetcher = async (
  url: string,
  init?: RequestInit | undefined,
  emailAccountId?: string | null,
) => {
  const headers = new Headers(init?.headers);

  if (emailAccountId) {
    headers.set(EMAIL_ACCOUNT_HEADER, emailAccountId);
  }

  const newInit = { ...init, headers };

  const res = await fetch(url, newInit);

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

        console.log(`${errorMessage}, redirecting to consent page...`);
        const redirectUrl = getPermissionsConsentPath(emailAccountId, {
          expired: true,
        });
        redirectToSafeUrl(redirectUrl);
        return;
      }
    }

    const sessionExpired = isSessionExpiredErrorBody(errorData);
    if (sessionExpired) notifySessionExpired();

    const errorMessage = sessionExpired
      ? SESSION_EXPIRED_MESSAGE
      : getSWRFetchErrorMessage(errorData);
    const error: Error & { info?: Record<string, unknown>; status?: number } =
      new Error(errorMessage);

    // Attach extra info to the error object.
    error.info = errorData;
    error.status = res.status;

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
