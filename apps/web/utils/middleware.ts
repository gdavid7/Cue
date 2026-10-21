import { ZodError } from "zod";
import { type NextRequest, NextResponse, after } from "next/server";
import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/nextjs";
import {
  captureException,
  checkCommonErrors,
  getEmailProviderRateLimitMessage,
  SafeError,
} from "@/utils/error";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import { extractErrorInfo as extractGmailErrorInfo } from "@/utils/gmail/retry";
import { extractErrorInfo as extractOutlookErrorInfo } from "@/utils/outlook/retry";
import {
  isPublicApiPath,
  publicApiErrorFromUnknown,
  publicApiErrorResponse,
} from "@/utils/public-api-error";
import { env } from "@/env";
import { logErrorToPosthog } from "@/utils/error.server";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { flushLoggerSafely } from "@/utils/logger-flush";
import { auth } from "@/utils/auth";
import { startEmailAccountOwnershipCheck } from "@/utils/redis/account-validation";
import { getCallerEmailAccount } from "@/utils/organizations/access";
import {
  getProviderRateLimitRetryAfterSeconds,
  recordRateLimitFromApiError,
} from "@/utils/email/rate-limit";
import {
  getProviderRateLimitApiErrorType,
  isProviderRateLimitModeError,
  toRateLimitProvider,
} from "@/utils/email/rate-limit-mode-error";
import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import {
  EMAIL_ACCOUNT_HEADER,
  EMAIL_ACCOUNT_ID_REQUIRED_ERROR,
  MICROSOFT_AUTH_EXPIRED_ERROR_CODE,
  NO_REFRESH_TOKEN_ERROR_CODE,
  SESSION_EXPIRED_ERROR_CODE,
} from "@/utils/config";
import { isAdmin } from "@/utils/admin";
import prisma from "@/utils/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import { runWithRequestDeadline } from "@/utils/request-deadline";
import {
  getFastRequestSampleRate,
  isFastRequestSampled,
} from "@/utils/request-sampling";
import { startRequestTimer } from "@/utils/request-timing";
import {
  createRequestMetrics,
  getRequestMetricsFields,
  runWithRequestMetrics,
  timeRequestDependency,
} from "@/utils/request-metrics";
import {
  type AuditActorType,
  runWithAuditContext,
  setAuditContext,
} from "@/utils/audit/context";

const logger = createScopedLogger("middleware");
const SLOW_MIDDLEWARE_STEP_MS = 2000;
const SLOW_MIDDLEWARE_TOTAL_MS = 4000;
const SLOW_REQUEST_MS = 1000;
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type NextHandler<T extends NextRequest = NextRequest> = (
  req: T,
  context: { params: Promise<Record<string, string>> },
) => Promise<Response>;

export interface RequestWithLogger extends NextRequest {
  logger: Logger;
}

// Extended request type with validated account info
export interface RequestWithAuth extends RequestWithLogger {
  auth: { userId: string; emailOtp?: boolean };
}

export interface RequestWithEmailAccount extends RequestWithLogger {
  auth: {
    userId: string;
    emailAccountId: string;
    email: string;
  };
}
export interface RequestWithEmailProvider extends RequestWithEmailAccount {
  emailProvider: EmailProvider;
}

export interface MiddlewareOptions {
  allowOrgAdmins?: boolean;
  /**
   * The route's `maxDuration` in seconds. Its provider retries and Gmail
   * quota waits then give up in time to answer before the platform kills it.
   */
  maxDuration?: number;
  /**
   * A POST that only reads, such as mail sync. Like a GET it trusts the
   * session cookie cache (up to a minute stale after revocation) instead of
   * checking the session in the database. Side effects such a route may have
   * must be bookkeeping the caller cannot steer, like the debounced Gmail
   * catch-up nudge mail/v1 changes schedules.
   */
  readOnly?: boolean;
  requestTiming?: {
    runningWarnAfterMs?: number;
    slowWarnAfterMs?: number;
  };
}

// Higher-order middleware factory that handles common error logic
function withMiddleware<T extends NextRequest>(
  handler: NextHandler<T>,
  middleware?: (
    req: NextRequest,
    options?: MiddlewareOptions,
  ) => Promise<T | Response>,
  options?: MiddlewareOptions,
  scope?: string,
): NextHandler {
  return async (req, context) => {
    const requestId = getRequestId(req.headers.get("x-request-id"));
    // x-request-id is client-controlled, so sampling hashes its own id.
    const samplingId = randomUUID();
    const baseLogger = createScopedLogger(scope || "api").with({
      requestId,
      url: getRequestPath(req),
    });
    const requestTimer =
      options?.requestTiming !== undefined
        ? startRequestTimer({
            logger: baseLogger,
            requestName: `${scope || "api"} request`,
            runningWarnAfterMs: options.requestTiming.runningWarnAfterMs,
            slowWarnAfterMs: options.requestTiming.slowWarnAfterMs,
          })
        : undefined;

    const reqWithLogger = req as NextRequest & { logger?: Logger };
    reqWithLogger.logger = baseLogger;
    let requestForError = reqWithLogger as NextRequest;
    const startedAt = Date.now();
    const requestMetrics = createRequestMetrics();
    // What the request paid before its handler ran: session and account
    // checks, and creating the provider. A request the middleware answered
    // itself spent all of it there, including an account read started
    // alongside the session and then discarded (a 401 or a refused account).
    let preHandler:
      | { preHandlerMs: number; preHandlerDbCalls: number }
      | undefined;
    const getPreHandlerFields = () =>
      preHandler ?? {
        preHandlerMs: Date.now() - startedAt,
        preHandlerDbCalls: requestMetrics.db.calls,
      };

    return runWithRequestMetrics(requestMetrics, () =>
      runWithAuditContext(
        {
          actorType: getDefaultAuditActorType(scope),
          requestId,
          source: scope || new URL(req.url).pathname,
        },
        async () => {
          try {
            return await runWithRequestDeadline(
              options?.maxDuration,
              async () => {
                // Apply middleware if provided
                let enhancedReq = reqWithLogger;
                if (middleware) {
                  const middlewareResult = await middleware(
                    reqWithLogger,
                    options,
                  );

                  // If middleware returned a Response, return it directly
                  if (middlewareResult instanceof Response) {
                    flushLogger(reqWithLogger);
                    return middlewareResult;
                  }

                  // Otherwise, continue with the enhanced request
                  enhancedReq = middlewareResult;
                }
                requestForError = enhancedReq;
                preHandler = {
                  preHandlerMs: Date.now() - startedAt,
                  preHandlerDbCalls: requestMetrics.db.calls,
                };

                // Execute the handler with the (potentially) enhanced request
                const response = await handler(enhancedReq as T, context);

                flushLogger(enhancedReq);

                return response;
              },
            );
          } catch (error) {
            flushLogger(requestForError);

            // redirects work by throwing an error. allow these
            if (isRedirectError(error)) throw error;

            const requestPath = getRequestPath(requestForError);
            const publicApiRequest = isPublicApiPath(
              new URL(requestForError.url).pathname,
            );

            if (error instanceof SafeError) {
              if (error.message === "No refresh token") {
                getLogger(requestForError).warn("Returning 401", {
                  reason: "no_refresh_token",
                });
                if (publicApiRequest) {
                  return publicApiErrorResponse({
                    status: 401,
                    code: "UNAUTHORIZED",
                    message:
                      "Authorization required. Please grant permissions.",
                  });
                }

                return NextResponse.json(
                  {
                    error: "Authorization required. Please grant permissions.",
                    errorCode: NO_REFRESH_TOKEN_ERROR_CODE,
                    isKnownError: true,
                  },
                  { status: 401 },
                );
              }

              if (
                error.message.includes("Microsoft authorization has expired")
              ) {
                getLogger(requestForError).warn("Returning 401", {
                  reason: "microsoft_authorization_expired",
                });
                if (publicApiRequest) {
                  return publicApiErrorResponse({
                    status: 401,
                    code: "UNAUTHORIZED",
                    message:
                      error.safeMessage ||
                      "Microsoft authorization has expired. Please reconnect.",
                  });
                }

                return NextResponse.json(
                  {
                    error: error.safeMessage,
                    errorCode: MICROSOFT_AUTH_EXPIRED_ERROR_CODE,
                    isKnownError: true,
                  },
                  { status: 401 },
                );
              }
            }

            const reqLogger = getLogger(requestForError);

            if (error instanceof ZodError) {
              if (!env.DISABLE_LOG_ZOD_ERRORS) {
                reqLogger.error("Zod validation error", { error });
              }
              if (publicApiRequest) {
                return publicApiErrorFromUnknown(error);
              }
              return NextResponse.json(
                { error: { issues: error.issues }, isKnownError: true },
                { status: 400 },
              );
            }

            const deferred = getGmailCallDeferredError(error);
            if (deferred) {
              reqLogger.info(
                "Gmail call deferred by the account's quota budget",
                {
                  priority: deferred.priority,
                  retryAfterMs: deferred.retryAfterMs,
                },
              );
              return NextResponse.json(
                {
                  error: "Gmail is busy for this account. Try again shortly.",
                  isKnownError: true,
                },
                {
                  status: 503,
                  headers: {
                    "Retry-After": String(
                      Math.ceil(deferred.retryAfterMs / 1000),
                    ),
                  },
                },
              );
            }

            const apiError =
              checkCommonErrors(error, requestPath, reqLogger) ??
              providerRateLimitApiError(error, requestForError);
            if (apiError) {
              await recordRateLimitFromApiError({
                apiErrorType: apiError.type,
                error,
                emailAccountId: getEmailAccountId(requestForError),
                logger: reqLogger,
                source: scope || new URL(requestForError.url).pathname,
              });
              const retryAfterSeconds = getProviderRateLimitRetryAfterSeconds(
                error,
                apiError.type,
              );

              await logErrorToPosthog(
                "api",
                requestPath,
                apiError.type,
                "unknown",
                reqLogger,
              ); // TODO: add emailAccountId

              if (publicApiRequest) {
                return publicApiErrorResponse({
                  status: apiError.code,
                  message: apiError.message || "Request failed",
                });
              }

              return NextResponse.json(
                { error: apiError.message, isKnownError: true },
                {
                  status: apiError.code,
                  headers: retryAfterSeconds
                    ? { "Retry-After": String(retryAfterSeconds) }
                    : undefined,
                },
              );
            }

            if (isErrorWithConfigAndHeaders(error)) {
              error.config.headers = undefined;
            }

            if (error instanceof SafeError) {
              if (publicApiRequest) {
                return publicApiErrorFromUnknown(error);
              }

              return NextResponse.json(
                { error: error.safeMessage, isKnownError: true },
                { status: getSafeErrorStatusCode(error.statusCode) },
              );
            }

            // Quick fix: log full error in development. TODO: handle properly
            if (env.NODE_ENV === "development") {
              // biome-ignore lint/suspicious/noConsole: helpful for debugging
              console.error(error);
            }

            reqLogger.error("Unhandled error", {
              error: error instanceof Error ? error.message : error,
              cause:
                error instanceof Error && error.cause
                  ? error.cause instanceof Error
                    ? error.cause.message
                    : error.cause
                  : undefined,
              stack: error instanceof Error ? error.stack : undefined,
            });
            captureException(error, {
              extra: { url: requestPath },
            });

            if (publicApiRequest) {
              return publicApiErrorResponse({
                status: 500,
                code: "INTERNAL_ERROR",
                message: "An unexpected error occurred",
              });
            }

            return NextResponse.json(
              { error: "An unexpected error occurred" },
              { status: 500 },
            );
          } finally {
            requestTimer?.logSlowCompletion();
            requestTimer?.stop();
          }
        },
      ).then(
        (response) => {
          logRequestCompleted(getLogger(requestForError), samplingId, scope, {
            method: req.method,
            status: response.status,
            durationMs: Date.now() - startedAt,
            ...getRequestMetricsFields(requestMetrics),
            ...getPreHandlerFields(),
          });
          return response;
        },
        (error: unknown) => {
          logRequestCompleted(getLogger(requestForError), samplingId, scope, {
            method: req.method,
            // Only a redirect is rethrown on purpose; Next answers anything else
            // with a 500.
            status: isRedirectError(error) ? getRedirectStatus(error) : 500,
            durationMs: Date.now() - startedAt,
            ...getRequestMetricsFields(requestMetrics),
            ...getPreHandlerFields(),
          });
          throw error;
        },
      ),
    );
  };
}

function authMiddleware(req: NextRequest, options?: MiddlewareOptions) {
  return authenticate(req, getAuthLogContext(req), {
    disableCookieCache: mayChangeState(req, options),
  });
}

async function authenticate(
  req: NextRequest,
  authLogContext: AuthLogContext,
  { disableCookieCache }: { disableCookieCache: boolean },
): Promise<RequestWithAuth | Response> {
  const baseLogger = getLogger(req);

  let session: Awaited<ReturnType<typeof auth>>;
  try {
    session = await timeRequestDependency("auth", () =>
      auth(req.headers, { disableCookieCache }),
    );
  } catch (error) {
    baseLogger.warn("Auth middleware failed", {
      ...authLogContext,
      authError:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : error,
    });
    throw error;
  }

  if (!session?.user) {
    baseLogger.warn("Auth middleware returning 401", {
      ...authLogContext,
      reason: getUnauthorizedReason({
        session,
        cookieNames: authLogContext.cookieNames,
        hasAuthorization: authLogContext.hasAuthorization,
      }),
    });

    return NextResponse.json(
      {
        error: "Unauthorized",
        errorCode: SESSION_EXPIRED_ERROR_CODE,
        isKnownError: true,
      },
      { status: 401 },
    );
  }

  const authReq = req as RequestWithAuth;
  authReq.auth = {
    userId: session.user.id,
    ...(session.session?.emailOtp ? { emailOtp: true } : {}),
  };

  authReq.logger = baseLogger.with({ userId: session.user.id });
  setAuditContext({ actorType: "user", userId: session.user.id });

  return authReq;
}

// Why a request carried no usable session, from what the request itself
// shows. A session cookie that no longer resolves is an expired, revoked or
// deleted session: the auth library does not say which.
export function getUnauthorizedReason({
  session,
  cookieNames,
  hasAuthorization,
}: {
  session: unknown;
  cookieNames: string[];
  hasAuthorization: boolean;
}) {
  if (session && typeof session === "object") return "session_without_user";
  if (hasAuthorization && cookieNames.length === 0)
    return "authorization_header_without_cookie";
  if (cookieNames.length === 0) return "no_cookies";
  if (!cookieNames.some((name) => name.includes("session_token")))
    return "no_session_cookie";
  return "session_cookie_unresolved";
}

type AuthLogContext = ReturnType<typeof getAuthLogContext>;

function getAuthLogContext(req: NextRequest) {
  return {
    path: new URL(req.url).pathname,
    method: req.method,
    hasCookie: req.headers.has("cookie"),
    cookieNames: parseCookieNames(req.headers.get("cookie")),
    hasAuthorization: req.headers.has("authorization"),
    expoOrigin: req.headers.get("expo-origin") ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  };
}

// A revoked session's cookie cache still passes until it expires, so a request
// that can change something checks the session in the database instead.
function mayChangeState(req: NextRequest, options?: MiddlewareOptions) {
  if (options?.readOnly) return false;
  return !["GET", "HEAD", "OPTIONS"].includes(req.method);
}

// False only when the request offers nothing a session could come from, so
// its 401 is certain before the session lookup answers.
function mayCarrySession({ cookieNames, hasAuthorization }: AuthLogContext) {
  return (
    hasAuthorization ||
    cookieNames.some((name) => name.includes("session_token"))
  );
}

function parseCookieNames(cookieHeader: string | null): string[] {
  if (!cookieHeader) return [];
  return cookieHeader
    .split(";")
    .map((part) => part.split("=")[0]?.trim())
    .filter((name): name is string => Boolean(name));
}

async function emailAccountMiddleware(
  req: NextRequest,
  options?: MiddlewareOptions,
): Promise<RequestWithEmailAccount | Response> {
  const result = await resolveEmailAccount(req, options);
  return result instanceof Response ? result : result.request;
}

// The account is read alongside the session rather than after it; it is
// still only accepted for the user the session names.
async function resolveEmailAccount(
  req: NextRequest,
  options?: MiddlewareOptions,
): Promise<
  { request: RequestWithEmailAccount; provider: string | null } | Response
> {
  const emailAccountId = req.headers.get(EMAIL_ACCOUNT_HEADER);
  const authLogContext = getAuthLogContext(req);
  // A request that cannot have a session is not worth an account read; should
  // the session lookup still find one, the account is read after it instead.
  let checkOwnership =
    emailAccountId && mayCarrySession(authLogContext)
      ? startEmailAccountOwnershipCheck(emailAccountId)
      : null;

  const authReq = await authenticate(req, authLogContext, {
    disableCookieCache: mayChangeState(req, options),
  });
  if (authReq instanceof Response) return authReq;

  const userId = authReq.auth.userId;
  if (emailAccountId)
    checkOwnership ??= startEmailAccountOwnershipCheck(emailAccountId);

  if (!emailAccountId || !checkOwnership) {
    return NextResponse.json(
      { error: EMAIL_ACCOUNT_ID_REQUIRED_ERROR, isKnownError: true },
      { status: 403 },
    );
  }

  const middlewareLogger = authReq.logger.with({ emailAccountId });
  const middlewareStartTime = Date.now();

  try {
    // If account ID is provided, validate and get the email account ID
    const ownedEmailAccount = await runTimedMiddlewareStep({
      logger: middlewareLogger,
      step: "validate-email-account",
      operation: () => checkOwnership(userId),
    });
    const email = ownedEmailAccount?.email ?? null;

    const emailAccountLogger = middlewareLogger.with({ email });

    if (!email && options?.allowOrgAdmins) {
      // Check if user is admin or owner and is in the same org as the target email account
      const callerEmailAccount = await runTimedMiddlewareStep({
        logger: emailAccountLogger,
        step: "resolve-org-admin-caller-account",
        operation: () => getCallerEmailAccount(userId, emailAccountId),
      });

      if (!callerEmailAccount) {
        emailAccountLogger.error("Org admin access denied");
        return NextResponse.json(
          { error: "Insufficient permissions", isKnownError: true },
          { status: 403 },
        );
      }

      // Check if target member has consented to org admin analytics access
      const targetMember = await runTimedMiddlewareStep({
        logger: emailAccountLogger,
        step: "check-org-admin-consent",
        operation: () =>
          prisma.member.findFirst({
            where: {
              emailAccountId,
              organization: {
                members: {
                  some: {
                    emailAccountId: callerEmailAccount.id,
                  },
                },
              },
            },
            select: { allowOrgAdminAnalytics: true },
          }),
      });

      if (!targetMember?.allowOrgAdminAnalytics) {
        emailAccountLogger.error(
          "Member has not enabled org admin analytics access",
        );
        return NextResponse.json(
          {
            error: "Analytics access not permitted by this member",
            isKnownError: true,
          },
          { status: 403 },
        );
      }

      const targetEmailAccount = await runTimedMiddlewareStep({
        logger: emailAccountLogger,
        step: "resolve-org-admin-target-account",
        operation: () =>
          prisma.emailAccount.findUnique({
            where: { id: emailAccountId },
            select: { email: true },
          }),
      });

      if (targetEmailAccount) {
        setAuditContext({
          actorType: "admin",
          emailAccountId,
          userId,
        });

        const emailAccountReq = authReq as RequestWithEmailAccount;
        emailAccountReq.auth = {
          userId,
          emailAccountId,
          email: targetEmailAccount.email,
        };
        emailAccountReq.logger = emailAccountLogger.with({
          isOrgAdmin: true,
          email: targetEmailAccount.email,
        });
        return { request: emailAccountReq, provider: null };
      }
    }

    if (!email) {
      emailAccountLogger.error("Invalid email account ID");
      return NextResponse.json(
        { error: "Invalid account ID", isKnownError: true },
        { status: 403 },
      );
    }

    Sentry.setTag("emailAccountId", emailAccountId);
    Sentry.setUser({ id: userId, email });
    setAuditContext({
      actorType: "email_account",
      emailAccountId,
      userId,
    });

    const emailAccountReq = authReq as RequestWithEmailAccount;
    emailAccountReq.auth = { userId, emailAccountId, email };
    emailAccountReq.logger = emailAccountLogger;

    return {
      request: emailAccountReq,
      provider: ownedEmailAccount?.provider ?? null,
    };
  } finally {
    logSlowMiddlewareTotal({
      logger: middlewareLogger,
      middleware: "email-account",
      startedAt: middlewareStartTime,
    });
  }
}

async function emailProviderMiddleware(
  req: NextRequest,
  options?: MiddlewareOptions,
): Promise<RequestWithEmailProvider | Response> {
  // allowOrgAdmins never applied to provider access; only readOnly does.
  const resolved = await resolveEmailAccount(req, {
    readOnly: options?.readOnly,
  });
  if (resolved instanceof Response) return resolved;

  const emailAccountReq = resolved.request;
  const { userId, emailAccountId } = emailAccountReq.auth;
  const middlewareStartTime = Date.now();

  try {
    const accountProvider = resolved.provider;
    if (!accountProvider) {
      return NextResponse.json(
        { error: "Email account not found", isKnownError: true },
        { status: 404 },
      );
    }

    const provider = await runTimedMiddlewareStep({
      logger: emailAccountReq.logger,
      step: "create-email-provider",
      operation: () =>
        createEmailProvider({
          emailAccountId,
          provider: accountProvider,
          logger: emailAccountReq.logger,
        }),
    });

    const providerReq = emailAccountReq as RequestWithEmailProvider;
    providerReq.auth = emailAccountReq.auth;
    providerReq.emailProvider = provider;
    providerReq.logger = emailAccountReq.logger;

    return providerReq;
  } catch (error) {
    emailAccountReq.logger.error("Failed to create email provider", {
      error,
      emailAccountId,
      userId,
    });

    // Re-throw known errors so withMiddleware can apply shared error handling.
    if (error instanceof SafeError || isProviderRateLimitModeError(error)) {
      throw error;
    }

    return NextResponse.json(
      { error: "Failed to initialize email provider" },
      { status: 500 },
    );
  } finally {
    logSlowMiddlewareTotal({
      logger: emailAccountReq.logger,
      middleware: "email-provider",
      startedAt: middlewareStartTime,
    });
  }
}

async function adminMiddleware(
  req: NextRequest,
): Promise<RequestWithAuth | Response> {
  const authReq = await authenticate(req, getAuthLogContext(req), {
    disableCookieCache: true,
  });
  if (authReq instanceof Response) return authReq;

  const user = await prisma.user.findUnique({
    where: { id: authReq.auth.userId },
    select: { email: true },
  });

  if (!isAdmin({ email: user?.email })) {
    return NextResponse.json(
      { error: "Unauthorized", isKnownError: true },
      { status: 403 },
    );
  }

  setAuditContext({ actorType: "admin", userId: authReq.auth.userId });

  return authReq;
}

// Public middlewares that build on the common infrastructure

// withError overloads
export function withError(
  scope: string,
  handler: NextHandler<RequestWithLogger>,
  options?: MiddlewareOptions,
): NextHandler;
export function withError(
  handler: NextHandler<RequestWithLogger>,
  options?: MiddlewareOptions,
): NextHandler;
export function withError(
  scopeOrHandler: string | NextHandler | NextHandler<RequestWithLogger>,
  handlerOrOptions?: NextHandler<RequestWithLogger> | MiddlewareOptions,
  options?: MiddlewareOptions,
): NextHandler {
  if (typeof scopeOrHandler === "string") {
    return withMiddleware(
      handlerOrOptions as NextHandler<RequestWithLogger>,
      undefined,
      options,
      scopeOrHandler,
    );
  }
  return withMiddleware(
    scopeOrHandler as NextHandler,
    undefined,
    handlerOrOptions as MiddlewareOptions,
  );
}

// withAuth overloads
export function withAuth(
  scope: string,
  handler: NextHandler<RequestWithAuth>,
  options?: Pick<MiddlewareOptions, "maxDuration" | "readOnly">,
): NextHandler;
export function withAuth(handler: NextHandler<RequestWithAuth>): NextHandler;
export function withAuth(
  scopeOrHandler: string | NextHandler<RequestWithAuth>,
  handler?: NextHandler<RequestWithAuth>,
  options?: Pick<MiddlewareOptions, "maxDuration" | "readOnly">,
): NextHandler {
  if (typeof scopeOrHandler === "string") {
    return withMiddleware(handler!, authMiddleware, options, scopeOrHandler);
  }
  return withMiddleware(scopeOrHandler, authMiddleware);
}

export function withAdmin(
  scope: string,
  handler: NextHandler<RequestWithAuth>,
): NextHandler {
  return withMiddleware(handler, adminMiddleware, undefined, scope);
}

// withEmailAccount overloads
export function withEmailAccount(
  scope: string,
  handler: NextHandler<RequestWithEmailAccount>,
  options?: MiddlewareOptions,
): NextHandler;
export function withEmailAccount(
  handler: NextHandler<RequestWithEmailAccount>,
  options?: MiddlewareOptions,
): NextHandler;
export function withEmailAccount(
  scopeOrHandler: string | NextHandler<RequestWithEmailAccount>,
  handlerOrOptions?: NextHandler<RequestWithEmailAccount> | MiddlewareOptions,
  options?: MiddlewareOptions,
): NextHandler {
  if (typeof scopeOrHandler === "string") {
    return withMiddleware(
      handlerOrOptions as NextHandler<RequestWithEmailAccount>,
      emailAccountMiddleware,
      options,
      scopeOrHandler,
    );
  }
  return withMiddleware(
    scopeOrHandler,
    emailAccountMiddleware,
    handlerOrOptions as MiddlewareOptions,
  );
}

// withEmailProvider overloads
export function withEmailProvider(
  scope: string,
  handler: NextHandler<RequestWithEmailProvider>,
  options?: MiddlewareOptions,
): NextHandler;
export function withEmailProvider(
  handler: NextHandler<RequestWithEmailProvider>,
  options?: MiddlewareOptions,
): NextHandler;
export function withEmailProvider(
  scopeOrHandler: string | NextHandler<RequestWithEmailProvider>,
  handlerOrOptions?: NextHandler<RequestWithEmailProvider> | MiddlewareOptions,
  options?: MiddlewareOptions,
): NextHandler {
  if (typeof scopeOrHandler === "string") {
    return withMiddleware(
      handlerOrOptions as NextHandler<RequestWithEmailProvider>,
      emailProviderMiddleware,
      options,
      scopeOrHandler,
    );
  }
  return withMiddleware(
    scopeOrHandler,
    emailProviderMiddleware,
    handlerOrOptions as MiddlewareOptions,
  );
}

function isErrorWithConfigAndHeaders(
  error: unknown,
): error is { config: { headers: unknown } } {
  return (
    typeof error === "object" &&
    error !== null &&
    "config" in error &&
    "headers" in (error as { config: Record<string, unknown> }).config
  );
}

function getLogger(req: NextRequest): Logger {
  const reqWithLogger = req as RequestWithLogger;
  return reqWithLogger.logger || logger;
}

function getEmailAccountId(req: NextRequest): string | undefined {
  const authReq = req as Partial<RequestWithEmailAccount>;
  return authReq.auth?.emailAccountId;
}

function getDefaultAuditActorType(scope?: string): AuditActorType {
  return scope?.startsWith("cron/") ? "system" : "anonymous";
}

function getRequestId(rawRequestId: string | null) {
  if (rawRequestId && UUID_V4_REGEX.test(rawRequestId)) return rawRequestId;
  return randomUUID();
}

function getRequestPath(req: NextRequest) {
  return req.nextUrl.pathname;
}

function flushLogger(req: NextRequest) {
  const reqWithLogger = req as RequestWithLogger;
  if (reqWithLogger.logger) {
    const loggerToFlush = reqWithLogger.logger;
    after(async () => {
      await flushLoggerSafely(loggerToFlush, { url: getRequestPath(req) });
    });
  }
}

async function runTimedMiddlewareStep<T>({
  logger,
  step,
  operation,
}: {
  logger: Logger;
  step: string;
  operation: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  const slowStepLogTimeout = setTimeout(() => {
    logger.warn("Middleware step still running", {
      step,
      elapsedMs: Date.now() - startedAt,
    });
  }, SLOW_MIDDLEWARE_STEP_MS);

  try {
    return await operation();
  } finally {
    clearTimeout(slowStepLogTimeout);
    const durationMs = Date.now() - startedAt;
    if (durationMs > SLOW_MIDDLEWARE_STEP_MS) {
      logger.warn("Middleware step completed slowly", {
        step,
        durationMs,
      });
    }
  }
}

// Slow and failed requests always log at info, which ships to Axiom. Fast ones
// ship for a deterministic share of request ids, marked `sampled` with their
// `sampleRate`; the rest log at trace, which ships only while ENABLE_DEBUG_LOGS
// is on. The logger's scope and url name the route.
function logRequestCompleted(
  logger: Logger,
  samplingId: string,
  scope: string | undefined,
  fields: {
    method: string;
    status: number;
    durationMs: number;
    preHandlerMs: number;
    preHandlerDbCalls: number;
  } & ReturnType<typeof getRequestMetricsFields>,
) {
  const sampleRate = getFastRequestSampleRate(scope);
  if (fields.durationMs >= SLOW_REQUEST_MS || fields.status >= 500) {
    logger.info("Request completed", fields);
  } else if (isFastRequestSampled(samplingId, sampleRate)) {
    logger.info("Request completed", { ...fields, sampled: true, sampleRate });
  } else {
    logger.trace("Request completed", fields);
  }
}

function isRedirectError(error: unknown): error is Error {
  return error instanceof Error && error.message === "NEXT_REDIRECT";
}

// Next puts the status in the digest, "NEXT_REDIRECT;type;url;status;":
// redirect() throws 307 and permanentRedirect() 308.
function getRedirectStatus(error: Error) {
  const digest = (error as Error & { digest?: unknown }).digest;
  const status =
    typeof digest === "string" ? Number(digest.split(";").at(-2)) : Number.NaN;
  return Number.isInteger(status) ? status : 307;
}

function logSlowMiddlewareTotal({
  logger,
  middleware,
  startedAt,
}: {
  logger: Logger;
  middleware: string;
  startedAt: number;
}) {
  const durationMs = Date.now() - startedAt;
  if (durationMs > SLOW_MIDDLEWARE_TOTAL_MS) {
    logger.warn("Middleware completed slowly", {
      middleware,
      durationMs,
    });
  }
}

// A rate limit the provider's known error shapes don't name, such as a
// bare 429 inside a batch failure, is still a rate limit. Only an error
// carrying the provider's HTTP response counts: an AI provider's "Rate limit
// exceeded" on the same request is not the mailbox's.
function providerRateLimitApiError(error: unknown, req: NextRequest) {
  const provider = toRateLimitProvider(
    (req as Partial<RequestWithEmailProvider>).emailProvider?.name,
  );
  if (!provider) return null;
  const status =
    provider === "google"
      ? extractGmailErrorInfo(error).status
      : extractOutlookErrorInfo(error).status;
  if (
    (status !== 403 && status !== 429) ||
    !isEmailProviderRateLimitError({ error, provider })
  )
    return null;
  return {
    type: getProviderRateLimitApiErrorType(provider),
    message: getEmailProviderRateLimitMessage(provider),
    code: 429,
  };
}

function getSafeErrorStatusCode(statusCode?: number) {
  return typeof statusCode === "number" &&
    Number.isInteger(statusCode) &&
    statusCode >= 400 &&
    statusCode <= 599
    ? statusCode
    : 400;
}
