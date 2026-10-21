import { APIError } from "better-auth";
import {
  createAuthMiddleware,
  getAuthoritativeSessionFromCtx,
} from "better-auth/api";

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
]);

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
      ],
    },
  };
}
