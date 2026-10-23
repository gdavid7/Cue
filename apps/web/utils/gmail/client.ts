import { auth, gmail, type gmail_v1 } from "@googleapis/gmail";
import type {
  GaxiosOptions,
  GaxiosOptionsPrepared,
  GaxiosPromise,
} from "gaxios";
import { people } from "@googleapis/people";
import { saveTokens } from "@/utils/auth/save-tokens";
import { cleanupInvalidTokens } from "@/utils/auth/cleanup-invalid-tokens";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { SCOPES } from "@/utils/gmail/scopes";
import { SafeError } from "@/utils/error";
import { classifyEmailAccountProviderIssue } from "@/utils/email/provider-health";
import { env } from "@/env";
import {
  getGoogleGmailApiRootUrl,
  getGoogleOauthClientOptions,
  getGooglePeopleApiRootUrl,
} from "@/utils/gmail/oauth";
import {
  admitGmailCall,
  currentGmailQuotaContext,
  gmailRequestCost,
  meterGmailCall,
  rememberGmailAccessToken,
} from "@/utils/gmail/quota";
import { withGmailInflightSlot } from "@/utils/gmail/inflight";
import { extractErrorInfo } from "@/utils/gmail/retry";

type AuthOptions = {
  accessToken?: string | null;
  refreshToken?: string | null;
  expiryDate?: number | null;
  expiresAt?: number | null;
};

const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

const getAuth = ({
  accessToken,
  refreshToken,
  expiresAt,
  ...rest
}: AuthOptions) => {
  const expiryDate = expiresAt ? expiresAt : rest.expiryDate;

  const googleAuth = new auth.OAuth2(getGoogleOauthClientOptions());
  googleAuth.setCredentials({
    access_token: accessToken,
    refresh_token: refreshToken,
    expiry_date: expiryDate,
    scope: SCOPES.join(" "),
  });

  return googleAuth;
};

export function getLinkingOAuth2Client() {
  return new auth.OAuth2(
    getGoogleOauthClientOptions(
      `${env.NEXT_PUBLIC_BASE_URL}/api/google/linking/callback`,
    ),
  );
}

// we should potentially use this everywhere instead of getGmailClient as this handles refreshing the access token and saving it to the db
export const getGmailClientWithRefresh = async ({
  accessToken,
  refreshToken,
  expiresAt,
  emailAccountId,
  logger,
}: {
  accessToken?: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  emailAccountId: string;
  logger: Logger;
}): Promise<gmail_v1.Gmail> => {
  if (!refreshToken) {
    // expected for disconnected accounts
    logger.info("No refresh token", { emailAccountId });
    await cleanupInvalidTokens({
      emailAccountId,
      reason: "invalid_grant",
      failedAccessToken: accessToken ?? undefined,
      failedRefreshToken: null,
      logger,
    }).catch((error) =>
      logger.warn("Failed to record missing refresh token", { error }),
    );
    throw new SafeError("No refresh token");
  }

  // Without the token's expiry, the auth client refreshes the token and
  // resends any call Gmail answers 401 or 403, so every quota refusal reached
  // Gmail twice and the resend went past the quota gate. Knowing the expiry,
  // it refreshes ahead of it instead; a 401 is handled in meterGmailRequests.
  const auth = getAuth({ accessToken, refreshToken, expiresAt });
  meterGmailRequests(auth, emailAccountId);
  const g = gmail({
    version: "v1",
    auth,
    rootUrl: getGoogleGmailApiRootUrl(),
    // Gmail answers a spent quota with 429 too; retrying it within
    // milliseconds only spends units that are not back yet.
    retryConfig: {
      statusCodesToRetry: [
        [100, 199],
        [408, 408],
        [500, 599],
      ],
    },
  });

  const expiryDate = expiresAt ? expiresAt : null;
  if (expiryDate && expiryDate > Date.now() + TOKEN_REFRESH_BUFFER_MS) {
    return g;
  }

  // may throw `invalid_grant` error
  try {
    const tokens = await auth.refreshAccessToken();
    const newAccessToken = tokens.credentials.access_token;

    if (newAccessToken !== accessToken) {
      await saveTokens({
        tokens: {
          access_token: newAccessToken ?? undefined,
          expires_at: tokens.credentials.expiry_date
            ? Math.floor(tokens.credentials.expiry_date / 1000)
            : undefined,
        },
        accountRefreshToken: refreshToken,
        emailAccountId,
        provider: "google",
        expectedExpiresAt: expiresAt,
      });
    }

    return g;
  } catch (error) {
    // Only this refresh knows which credentials failed, so it owns cleanup for
    // every account-level refusal (revoked grant, blocking security policy).
    const issue = classifyEmailAccountProviderIssue({
      error,
      provider: "google",
    });
    if (issue) {
      logger.warn("Error refreshing Gmail access token", {
        emailAccountId,
        reason: issue.reason,
        error: error instanceof Error ? error.message : String(error),
        // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
        errorDescription: (error as any).response?.data?.error_description,
        ...gmailRefreshFailureCode(error),
      });

      try {
        await cleanupInvalidTokens({
          emailAccountId,
          reason: issue.reason,
          failedAccessToken: accessToken ?? undefined,
          failedRefreshToken: refreshToken,
          logger,
        });
      } catch (cleanupError) {
        logger.error(
          "Failed to clean up invalid tokens after refresh failure",
          {
            emailAccountId,
            cleanupError,
          },
        );
        throw error;
      }

      // The grant is gone and cleaned up: the same reconnect state as a
      // missing token (a 401 for API routes, not a 500 and a Sentry event).
      // The cause keeps it recognizable as invalid_grant.
      if (issue.reason === "invalid_grant") {
        throw Object.assign(new SafeError("No refresh token"), {
          cause: error,
        });
      }
    }

    if (!issue) {
      logger.warn("Gmail token refresh failed", {
        emailAccountId,
        error: error instanceof Error ? error.message : String(error),
        ...gmailRefreshFailureCode(error),
      });
    }
    throw error;
  }
};

function gmailRefreshFailureCode(error: unknown) {
  const response = (
    error as { response?: { status?: number; data?: { error?: string } } }
  )?.response;
  return {
    providerError: response?.data?.error,
    httpStatus: response?.status,
    errorCode: (error as { code?: string | number } | null)?.code,
  };
}

// doesn't handle refreshing the access token
// should probably use the same auth object as getGmailClientWithRefresh but not critical for now
export const getContactsClient = ({
  accessToken,
  refreshToken,
}: AuthOptions) => {
  const auth = getAuth({ accessToken, refreshToken });
  const contacts = people({
    version: "v1",
    auth,
    rootUrl: getGooglePeopleApiRootUrl(),
  });

  return contacts;
};

export const getAccessTokenFromClient = (client: gmail_v1.Gmail): string => {
  const authClient = client.context._options.auth;
  // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
  const accessToken = (authClient as any).credentials.access_token;
  if (!accessToken) throw new Error("No access token");
  const emailAccountId =
    typeof authClient === "object"
      ? meteredAccounts.get(authClient)
      : undefined;
  if (emailAccountId) rememberGmailAccessToken(accessToken, emailAccountId);
  return accessToken;
};

// Batch requests carry only the access token, so each metered auth client
// remembers its account to let the batch path charge the same budget.
const meteredAccounts = new WeakMap<object, string>();
const refreshLogger = createScopedLogger("gmail-client");

// Every REST call the Gmail client makes passes through the auth client's
// `request`, so this is where each call is charged to the account's budget
// and holds one of its in-flight slots while it is sent.
// Gmail charges every request it receives, so each retry Gaxios sends after
// a server error or timeout is admitted and charged as well. Token refreshes
// use the transporter directly and are not charged.
function meterGmailRequests(
  client: InstanceType<typeof auth.OAuth2>,
  emailAccountId: string,
) {
  const request = client.request.bind(client) as (
    options: GaxiosOptions,
  ) => Promise<unknown>;
  const send = (options: GaxiosOptions) => {
    // The client sends query parameters apart from the URL, and a read's
    // cost depends on its format.
    const url = new URL(String(options.url), "https://x");
    const format = options.params?.format;
    if (typeof format === "string") url.searchParams.set("format", format);
    const cost = gmailRequestCost(options.method ?? "GET", url);
    let attempts = 0;
    // Gaxios calls the adapter for every attempt it sends.
    const adapter = async <T>(
      prepared: GaxiosOptionsPrepared,
      defaultAdapter: (options: GaxiosOptionsPrepared) => GaxiosPromise<T>,
    ) => {
      // meterGmailCall admitted the first attempt.
      if (attempts++ > 0) await admitGmailCall({ emailAccountId, cost });
      // Held for the round trip only, not Gaxios's sleep between attempts.
      // A streamed response (a complete thread, an attachment) gives its
      // slot back once its headers arrive, before its body is read.
      return withGmailInflightSlot(
        {
          emailAccountId,
          priority: currentGmailQuotaContext().priority,
          signal: prepared.signal ?? undefined,
        },
        () =>
          options.adapter
            ? options.adapter(prepared, defaultAdapter)
            : defaultAdapter(prepared),
      );
    };
    return meterGmailCall({ emailAccountId, cost }, () =>
      request({ ...options, adapter }),
    );
  };
  const metered = async (options: GaxiosOptions) => {
    try {
      return await send(options);
    } catch (error) {
      if (extractErrorInfo(error).status !== 401) throw error;
      // Gmail rejected a token before its recorded expiry: it was revoked or
      // the stored expiry is wrong. One refresh and a charged resend.
      try {
        await client.refreshAccessToken();
      } catch (refreshError) {
        refreshLogger.warn("Gmail token refresh after 401 failed", {
          emailAccountId,
          ...gmailRefreshFailureCode(refreshError),
        });
        throw refreshError;
      }
      return send(options);
    }
  };
  client.request = metered as typeof client.request;
  meteredAccounts.set(client, emailAccountId);
}
