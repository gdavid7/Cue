import { APIError, type GenericEndpointContext } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { parseCookies } from "better-call";

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
            const token = await getSessionToken(ctx);
            if (!token || !(await isStoredSession(ctx, token)))
              throw APIError.from("UNAUTHORIZED", {
                message: "Unauthorized",
                code: "UNAUTHORIZED",
              });
          }),
        },
        {
          matcher: (ctx: { path?: string }) => ctx.path === AUTHORIZE_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const token = await getSessionToken(ctx);
            if (!token || (await isStoredSession(ctx, token))) return;
            ctx.context.session = null;
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

async function getSessionToken(ctx: GenericEndpointContext) {
  return ctx.getSignedCookie(
    ctx.context.authCookies.sessionToken.name,
    ctx.context.secret,
  );
}

// Reads the store directly: Better Auth's own lookup answers a failed read
// with no session, which would sign the user out during a database outage.
async function isStoredSession(ctx: GenericEndpointContext, token: string) {
  const stored = await ctx.context.internalAdapter
    .findSession(token)
    .catch((error) => {
      ctx.context.logger.error("Session lookup failed", error);
      throw APIError.from("SERVICE_UNAVAILABLE", {
        message: "Could not check the session. Try again shortly.",
        code: "SESSION_LOOKUP_FAILED",
      });
    });
  return !!stored && new Date(stored.session.expiresAt) > new Date();
}

// Rebuilt from the same parser the endpoint reads cookies with (first value of
// a name wins, names trimmed), so no spelling of a session cookie survives.
function withoutSessionCookies(ctx: GenericEndpointContext) {
  const isSessionCookie = sessionCookieMatcher(ctx);
  const kept = [...parseRequestCookies(ctx.headers)]
    .filter(([name]) => !isSessionCookie(name))
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`);
  const headers = new Headers(ctx.headers);
  headers.set("cookie", kept.join("; "));
  return headers;
}

function hadSessionCookieRemoved(ctx: GenericEndpointContext) {
  const isSessionCookie = sessionCookieMatcher(ctx);
  const has = (headers?: Headers) =>
    [...parseRequestCookies(headers).keys()].some(isSessionCookie);
  return has(ctx.request?.headers) && !has(ctx.headers);
}

function parseRequestCookies(headers?: Headers) {
  return parseCookies(headers?.get("cookie") ?? "");
}

function sessionCookieMatcher(ctx: GenericEndpointContext) {
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
