import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";
import {
  signedInBetterAuth,
  TEST_AUTH_ORIGIN,
} from "@/__tests__/better-auth-session";
import { revokedSessionGuardPlugin } from "@/utils/auth/revoked-session";

const REDIRECT_URI = "https://client.example.invalid/callback";

describe("revokedSessionGuardPlugin", () => {
  it.each([
    ["/update-user", { name: "Renamed" }],
    ["/unlink-account", { providerId: "google" }],
  ])("rejects %s for a revoked session the cookie cache still holds", async (path, body) => {
    const { auth, cookie, revoke } = await setup();
    await revoke();

    // Still cached: the session itself reads as signed in.
    expect(
      await auth.api.getSession({ headers: new Headers({ cookie }) }),
    ).not.toBeNull();
    expect((await post(auth, path, cookie, body)).status).toBe(401);
  });

  it("answers 503 for an account change when the session store fails", async () => {
    const { auth, cookie } = await setup();
    const context = await auth.$context;
    vi.spyOn(context.internalAdapter, "findSession").mockRejectedValue(
      new Error("database unavailable"),
    );

    const response = await post(auth, "/update-user", cookie, {
      name: "Renamed",
    });

    expect(response.status).toBe(503);
    expect(
      response.headers
        .getSetCookie()
        .some((setCookie) => setCookie.includes("Max-Age=0")),
    ).toBe(false);
  });

  it("still lets a live session change the account", async () => {
    const { auth, cookie } = await setup();
    expect(
      (await post(auth, "/update-user", cookie, { name: "Renamed" })).status,
    ).toBe(200);
  });

  it("leaves other endpoints to the cookie cache", async () => {
    const { auth, cookie, revoke } = await setup();
    await revoke();

    const response = await auth.handler(
      new Request(`${TEST_AUTH_ORIGIN}/api/auth/get-session`, {
        headers: { cookie },
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).not.toBeNull();
  });

  describe("OAuth authorization", () => {
    it("issues a code for a live session", async () => {
      const signedIn = await setup();
      const location = await authorize(signedIn, signedIn.cookie);

      expect(location.origin + location.pathname).toBe(REDIRECT_URI);
      expect(location.searchParams.get("code")).toBeTruthy();
    });

    it("sends a revoked session to sign in and clears its cookies", async () => {
      const signedIn = await setup();
      await signedIn.revoke();

      const response = await authorizeResponse(signedIn, signedIn.cookie);
      const location = new URL(
        response.headers.get("location") ?? "",
        TEST_AUTH_ORIGIN,
      );

      expect(location.pathname).toBe("/mcp/login");
      expect(location.searchParams.get("code")).toBeNull();
      for (const name of ["session_token", "session_data"]) {
        expect(
          response.headers
            .getSetCookie()
            .some(
              (setCookie) =>
                setCookie.startsWith(`better-auth.${name}=`) &&
                setCookie.includes("Max-Age=0"),
            ),
        ).toBe(true);
      }
    });

    // Each spelling still carries the session to Better Auth's own cookie
    // reading, or to none of it; either way no code is issued.
    it.each([
      [
        "padded names",
        (pairs: string[]) => pairs.map((pair) => pair.replace("=", " =")),
      ],
      ["repeated names", (pairs: string[]) => [...pairs, ...pairs]],
      [
        "a mixed-case copy",
        (pairs: string[]) => [
          ...pairs.map((pair) => pair.replace("better-auth", "Better-Auth")),
          ...pairs,
        ],
      ],
    ])("sends a revoked session written with %s to sign in", async (_spelling, respell) => {
      const signedIn = await setup();
      await signedIn.revoke();
      const cookie = respell(signedIn.cookie.split("; ")).join("; ");

      const location = await authorize(signedIn, cookie);

      expect(location.pathname).toBe("/mcp/login");
      expect(location.searchParams.get("code")).toBeNull();
    });

    it("answers 503 and keeps the session when the session store fails", async () => {
      const signedIn = await setup();
      const context = await signedIn.auth.$context;
      vi.spyOn(context.internalAdapter, "findSession").mockRejectedValue(
        new Error("database unavailable"),
      );

      const response = await authorizeResponse(signedIn, signedIn.cookie);

      expect(response.status).toBe(503);
      expect(response.headers.get("location")).toBeNull();
      expect(
        response.headers
          .getSetCookie()
          .some((setCookie) => setCookie.includes("Max-Age=0")),
      ).toBe(false);
    });

    it("sends a request without a session to sign in", async () => {
      const location = await authorize(await setup(), "");

      expect(location.pathname).toBe("/mcp/login");
    });
  });
});

async function setup() {
  const signedIn = await signedInBetterAuth({
    plugins: [
      jwt({ disableSettingJwtHeader: true }),
      oauthProvider({
        loginPage: "/mcp/login",
        consentPage: "/mcp/consent",
        scopes: ["openid"],
      }),
      revokedSessionGuardPlugin(),
    ],
    session: { cookieCache: { enabled: true, maxAge: 60 } },
  });
  // Skipping consent issues a code straight away, so only the session stands
  // between an authorization request and its code.
  const client = await signedIn.auth.api.adminCreateOAuthClient({
    headers: new Headers({ cookie: signedIn.cookie }),
    body: {
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
      skip_consent: true,
    },
  });
  return { ...signedIn, clientId: client.client_id };
}

type SignedIn = Awaited<ReturnType<typeof setup>>;
type TestAuth = SignedIn["auth"];

function post(
  auth: TestAuth,
  path: string,
  cookie: string,
  body: Record<string, unknown>,
) {
  return auth.handler(
    new Request(`${TEST_AUTH_ORIGIN}/api/auth${path}`, {
      method: "POST",
      headers: {
        cookie,
        "Content-Type": "application/json",
        origin: TEST_AUTH_ORIGIN,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function authorize(signedIn: SignedIn, cookie: string) {
  const response = await authorizeResponse(signedIn, cookie);
  return new URL(response.headers.get("location") ?? "", TEST_AUTH_ORIGIN);
}

function authorizeResponse({ auth, clientId }: SignedIn, cookie: string) {
  const verifier = "a".repeat(64);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: "openid",
    state: "state-1",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  return auth.handler(
    new Request(`${TEST_AUTH_ORIGIN}/api/auth/oauth2/authorize?${query}`, {
      headers: { cookie },
    }),
  );
}
