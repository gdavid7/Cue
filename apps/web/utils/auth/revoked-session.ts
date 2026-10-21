import { APIError } from "better-auth";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";

// Better Auth endpoints that change the account or grant access while
// trusting the session cookie cache. Each already answers 401 without a
// session, so checking the database instead only rejects a revoked session
// that the cache would still pass.
const SESSION_BOUND_CHANGES = new Set([
  "/link-social",
  "/unlink-account",
  "/update-user",
  "/oauth2/consent",
  "/oauth2/continue",
  "/oauth2/create-client",
  "/oauth2/update-client",
  "/oauth2/delete-client",
  "/oauth2/client/rotate-secret",
  "/oauth2/update-consent",
  "/oauth2/delete-consent",
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
]);

// Issues an authorization code without asking again once consent exists, and
// the token exchange never rechecks the session. Signed out, it redirects to
// the login page rather than answering 401, so a revoked session is made to
// look signed out instead of rejected.
const AUTHORIZE_PATH = "/oauth2/authorize";

export function revokedSessionGuardPlugin() {
  return {
    id: "revoked-session-guard",
    hooks: {
      before: [
        {
          matcher: (ctx: { path?: string }) =>
            !!ctx.path && SESSION_BOUND_CHANGES.has(ctx.path),
          handler: createAuthMiddleware(async (ctx) => {
            const session = await getAuthoritativeSessionFromCtx(ctx);
            if (!session?.session)
              throw APIError.from("UNAUTHORIZED", {
                message: "Unauthorized",
                code: "UNAUTHORIZED",
              });
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === AUTHORIZE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const { sessionToken } = ctx.context.authCookies;
            const token = await ctx.getSignedCookie(
              sessionToken.name,
              ctx.context.secret,
            );
            if (!token) return;
            if (await getAuthoritativeSessionFromCtx(ctx)) return;
            // A null session in context is read again from the request's
            // cookies, so the endpoint must not see them at all.
            return { context: { headers: withoutSessionCookies(ctx) } };
          }),
        },
      ],
      after: [
        {
          // The endpoint's own response replaces headers set before it ran.
          matcher: (ctx: { path?: string }) => ctx.path === AUTHORIZE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (hadSessionCookieRemoved(ctx)) deleteSessionCookie(ctx);
          }),
        },
      ],
    },
  };
}

type SessionCookieContext = {
  headers?: Headers;
  request?: Request;
  context: {
    authCookies: Record<
      "sessionToken" | "sessionData" | "dontRememberToken",
      { name: string }
    >;
  };
};

function withoutSessionCookies(ctx: SessionCookieContext) {
  const isSessionCookie = sessionCookieMatcher(ctx);
  const kept = cookieParts(ctx.headers).filter(
    (part) => !isSessionCookie(part.split("=")[0]),
  );
  const headers = new Headers(ctx.headers);
  headers.set("cookie", kept.join("; "));
  return headers;
}

function hadSessionCookieRemoved(ctx: SessionCookieContext) {
  const isSessionCookie = sessionCookieMatcher(ctx);
  const has = (headers?: Headers) =>
    cookieParts(headers).some((part) => isSessionCookie(part.split("=")[0]));
  return has(ctx.request?.headers) && !has(ctx.headers);
}

function sessionCookieMatcher(ctx: SessionCookieContext) {
  const { sessionToken, sessionData, dontRememberToken } =
    ctx.context.authCookies;
  const names = [sessionToken.name, sessionData.name, dontRememberToken.name];
  return (name: string) =>
    names.some(
      // The cookie cache is split into `name.0`, `name.1`… when large.
      (sessionName) =>
        name === sessionName || name.startsWith(`${sessionName}.`),
    );
}

function cookieParts(headers?: Headers) {
  return (headers?.get("cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}
