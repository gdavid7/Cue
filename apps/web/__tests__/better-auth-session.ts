import type { BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { vi } from "vitest";

export const TEST_AUTH_ORIGIN = "http://localhost:3000";

// A real Better Auth instance with one user signed in, holding both the
// session token and its cookie cache as a browser does. Imported from the
// real module so tests that mock "better-auth" can still use it.
export async function signedInBetterAuth<
  const Options extends Pick<BetterAuthOptions, "plugins" | "session">,
>(options: Options) {
  const { betterAuth } =
    await vi.importActual<typeof import("better-auth")>("better-auth");
  const now = new Date();
  const auth = betterAuth({
    baseURL: TEST_AUTH_ORIGIN,
    secret: "test-secret-with-enough-entropy-for-sessions",
    database: memoryAdapter({
      user: [
        {
          id: "owner",
          email: "owner@example.invalid",
          name: "Owner",
          emailVerified: true,
          createdAt: now,
          updatedAt: now,
        },
      ],
      session: [],
      account: [],
      verification: [],
    }),
    rateLimit: { enabled: false },
    ...options,
  });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession("owner");
  if (!session) throw new Error("No session");
  const tokenCookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, context.secret)}`)}`;
  const { headers } = await auth.handler(
    new Request(`${TEST_AUTH_ORIGIN}/api/auth/get-session`, {
      headers: { cookie: tokenCookie },
    }),
  );
  const cacheCookies = headers
    .getSetCookie()
    .filter((setCookie) => setCookie.startsWith("better-auth.session_data"))
    .map((setCookie) => setCookie.split(";")[0]);
  if (cacheCookies.length === 0) throw new Error("No cookie cache");
  return {
    auth,
    token: session.token,
    cookie: [tokenCookie, ...cacheCookies].join("; "),
    revoke: () => context.internalAdapter.deleteSession(session.token),
  };
}
