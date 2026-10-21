import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { makeSignature } from "better-auth/crypto";
import { revokedSessionGuardPlugin } from "@/utils/auth/revoked-session";

describe("revokedSessionGuardPlugin", () => {
  it("rejects a revoked session that the cookie cache still holds", async () => {
    const { auth, cookie, token } = await signedIn();
    expect((await updateName(auth, cookie)).status).toBe(200);

    await (await auth.$context).internalAdapter.deleteSession(token);

    // Still cached: the session itself reads as signed in.
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).not.toBeNull();
    expect((await updateName(auth, cookie)).status).toBe(401);
  });

  it("leaves other endpoints to the cookie cache", async () => {
    const { auth, cookie, token } = await signedIn();
    await (await auth.$context).internalAdapter.deleteSession(token);

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/get-session", {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).not.toBeNull();
  });
});

function updateName(
  auth: Awaited<ReturnType<typeof signedIn>>["auth"],
  cookie: string,
) {
  return auth.handler(
    new Request("http://localhost:3000/api/auth/update-user", {
      method: "POST",
      headers: {
        cookie,
        "Content-Type": "application/json",
        origin: "http://localhost:3000",
      },
      body: JSON.stringify({ name: "Renamed" }),
    }),
  );
}

async function signedIn() {
  const now = new Date();
  const auth = betterAuth({
    baseURL: "http://localhost:3000",
    secret: "test-secret-with-enough-entropy-for-revocation",
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
    plugins: [revokedSessionGuardPlugin()],
    session: { cookieCache: { enabled: true, maxAge: 60 } },
    rateLimit: { enabled: false },
  });
  const context = await auth.$context;
  const session = await context.internalAdapter.createSession("owner");
  if (!session) throw new Error("No session");
  const tokenCookie = `better-auth.session_token=${encodeURIComponent(`${session.token}.${await makeSignature(session.token, context.secret)}`)}`;
  const { headers } = await auth.api.getSession({
    headers: new Headers({ cookie: tokenCookie }),
    returnHeaders: true,
  });
  const cacheCookies = headers
    .getSetCookie()
    .filter((setCookie) => setCookie.startsWith("better-auth.session_data"))
    .map((setCookie) => setCookie.split(";")[0]);
  if (cacheCookies.length === 0) throw new Error("No cookie cache");
  return {
    auth,
    token: session.token,
    cookie: [tokenCookie, ...cacheCookies].join("; "),
  };
}
