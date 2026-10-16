import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearAccountDisconnectedErrorIfResolved } from "@/utils/error-messages";
import prisma from "@/utils/__mocks__/prisma";
import { connectCalendarAtSignIn } from "@/utils/calendar/connect-sign-in-calendar";
import { env } from "@/env";
import { expectReplyTrackingOn } from "@/__tests__/helpers";
import { logFirstSignIn } from "@/utils/analytics/activation";

const {
  mockValidateOAuthCallback,
  mockHandleAccountLinking,
  mockGetOAuthCodeResult,
  mockAcquireOAuthCodeLock,
  mockSetOAuthCodeResult,
  mockClearOAuthCode,
  mockGetToken,
  mockFetchGoogleOpenIdProfile,
  mockIsGoogleOauthEmulationEnabled,
  mockEnsureEmailAccountsWatched,
  mockAuth,
  mockAfter,
} = vi.hoisted(() => ({
  mockValidateOAuthCallback: vi.fn(),
  mockHandleAccountLinking: vi.fn(),
  mockGetOAuthCodeResult: vi.fn(),
  mockAcquireOAuthCodeLock: vi.fn(),
  mockSetOAuthCodeResult: vi.fn(),
  mockClearOAuthCode: vi.fn(),
  mockGetToken: vi.fn(),
  mockFetchGoogleOpenIdProfile: vi.fn(),
  mockIsGoogleOauthEmulationEnabled: vi.fn(() => true),
  mockEnsureEmailAccountsWatched: vi.fn(),
  mockAuth: vi.fn(),
  mockAfter: vi.fn(),
}));

vi.mock("next/server", async (importActual) => ({
  ...(await importActual<typeof import("next/server")>()),
  after: mockAfter,
}));

vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-auth-secret",
    EMAIL_ENCRYPT_SALT: "test-email-salt",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
    GOOGLE_CLIENT_ID: "client-id",
  },
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

vi.mock("@/utils/prisma");
vi.mock("@/utils/analytics/activation", () => ({ logFirstSignIn: vi.fn() }));
vi.mock("@/utils/calendar/connect-sign-in-calendar", () => ({
  connectCalendarAtSignIn: vi.fn(),
}));
vi.mock("@/utils/error-messages", () => ({
  clearAccountDisconnectedErrorIfResolved: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/utils/oauth/callback-validation", () => ({
  validateOAuthCallback: mockValidateOAuthCallback,
}));

vi.mock("@/utils/oauth/account-linking", async (importActual) => {
  const actual =
    await importActual<typeof import("@/utils/oauth/account-linking")>();
  return {
    getMailboxLinkingBlockedRedirect: actual.getMailboxLinkingBlockedRedirect,
    handleAccountLinking: mockHandleAccountLinking,
  };
});

vi.mock("@/utils/user/merge-account", () => ({
  mergeAccount: vi.fn(),
}));

vi.mock("@/utils/redis/oauth-code", () => ({
  acquireOAuthCodeLock: mockAcquireOAuthCodeLock,
  getOAuthCodeResult: mockGetOAuthCodeResult,
  setOAuthCodeResult: mockSetOAuthCodeResult,
  clearOAuthCode: mockClearOAuthCode,
}));

vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(() => false),
}));

vi.mock("@/utils/gmail/client", () => ({
  getLinkingOAuth2Client: vi.fn(() => ({
    getToken: mockGetToken,
  })),
}));

vi.mock("@/utils/gmail/oauth", () => ({
  fetchGoogleOpenIdProfile: mockFetchGoogleOpenIdProfile,
  isGoogleOauthEmulationEnabled: mockIsGoogleOauthEmulationEnabled,
}));

vi.mock("@/utils/auth", () => ({
  auth: mockAuth,
}));

vi.mock("@/utils/email/watch-manager", () => ({
  ensureEmailAccountsWatched: mockEnsureEmailAccountsWatched,
}));

vi.mock("@/utils/error", async (importActual) => {
  const actual = await importActual<typeof import("@/utils/error")>();
  return actual;
});

import { GET } from "./route";

describe("google linking callback route", () => {
  const createRequest = (url: string, state = "valid-state") =>
    new NextRequest(url, {
      headers: {
        cookie: `google_linking_state=${state}`,
      },
    });

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidateOAuthCallback.mockReturnValue({
      success: true,
      targetUserId: "user-123",
      stateNonce: "state-nonce",
      code: "valid-auth-code",
    });
    mockGetOAuthCodeResult.mockResolvedValue(null);
    mockAcquireOAuthCodeLock.mockResolvedValue(true);
    mockEnsureEmailAccountsWatched.mockResolvedValue([]);
    mockAuth.mockResolvedValue({
      user: {
        id: "user-123",
      },
      session: { emailOtp: false },
    });
    mockGetToken.mockResolvedValue({
      tokens: {
        access_token: "access-token",
        refresh_token: "refresh-token",
        expiry_date: 1_700_000_000_000,
        id_token: "id-token",
        scope: "openid email profile",
        token_type: "Bearer",
      },
    });
    mockFetchGoogleOpenIdProfile.mockResolvedValue({
      sub: "new-provider-account-id",
      email: "user@example.com",
      email_verified: true,
      name: "Test User",
      picture: "https://example.com/avatar.png",
    });
    prisma.account.findUnique.mockResolvedValue(null);
    prisma.emailAccount.findFirst.mockResolvedValue(null);
    prisma.account.create.mockResolvedValue({
      id: "account-123",
      emailAccount: { id: "email-account-new" },
    } as Awaited<ReturnType<typeof prisma.account.create>>);
    prisma.account.update.mockResolvedValue({
      id: "account-123",
    } as Awaited<ReturnType<typeof prisma.account.update>>);
  });

  it.each([
    false,
    true,
  ])("restores an existing same-user account without duplication (watch lookup fails: %s)", async (watchFails) => {
    if (watchFails)
      mockEnsureEmailAccountsWatched.mockRejectedValueOnce(
        new Error("watch lookup failed"),
      );
    mockHandleAccountLinking.mockResolvedValue({
      type: "continue_create",
    });
    prisma.emailAccount.findFirst.mockResolvedValue({
      accountId: "existing-account-123",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findFirst>>);

    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );

    const redirectLocation = response.headers.get("location");
    expect(redirectLocation).toContain("success=tokens_updated");
    expect(prisma.account.update).toHaveBeenCalledWith({
      where: { id: "existing-account-123" },
      data: expect.objectContaining({
        disconnectedAt: null,
        providerAccountId: "new-provider-account-id",
        access_token: "access-token",
        refresh_token: "refresh-token",
        scope: "openid email profile",
      }),
    });
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(mockSetOAuthCodeResult).toHaveBeenCalledWith("valid-auth-code", {
      success: "tokens_updated",
    });
    expect(connectCalendarAtSignIn).toHaveBeenCalledWith({
      accountId: "existing-account-123",
      logger: expect.anything(),
    });
    expect(mockSetOAuthCodeResult.mock.invocationCallOrder[0]).toBeLessThan(
      mockAfter.mock.invocationCallOrder[0],
    );
    expect(mockEnsureEmailAccountsWatched).not.toHaveBeenCalled();

    await runScheduledAfterCallback();
    expect(
      mockEnsureEmailAccountsWatched.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(clearAccountDisconnectedErrorIfResolved).mock
        .invocationCallOrder[0],
    );
    expect(clearAccountDisconnectedErrorIfResolved).toHaveBeenCalledWith({
      userId: "user-123",
      logger: expect.anything(),
    });

    expect(mockEnsureEmailAccountsWatched).toHaveBeenCalledWith({
      userIds: ["user-123"],
      logger: expect.anything(),
    });
  });

  it("does not let an email code session link a mailbox", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "user-123" },
      session: { emailOtp: true },
    });
    mockHandleAccountLinking.mockResolvedValue({ type: "continue_create" });

    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );

    expect(response.headers.get("location")).toContain(
      "error=provider_sign_in_required",
    );
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockHandleAccountLinking).not.toHaveBeenCalled();
    expect(prisma.account.create).not.toHaveBeenCalled();
    expect(prisma.account.update).not.toHaveBeenCalled();
  });

  it("rejects signed linking state after the session is revoked", async () => {
    mockAuth.mockResolvedValue(null);
    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );
    expect(response.headers.get("location")).toContain("error=invalid_state");
    expect(mockGetOAuthCodeResult).not.toHaveBeenCalled();
    expect(mockHandleAccountLinking).not.toHaveBeenCalled();
  });

  it("rejects existing-account recovery when the Google email claim is unverified", async () => {
    mockHandleAccountLinking.mockResolvedValue({
      type: "update_existing_account",
      existingAccountId: "existing-account-123",
    });
    mockFetchGoogleOpenIdProfile.mockResolvedValue({
      sub: "new-provider-account-id",
      email: "user@example.com",
      email_verified: false,
      name: "Test User",
      picture: "https://example.com/avatar.png",
    });

    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );

    const redirectLocation = response.headers.get("location");
    expect(redirectLocation).toContain("error=link_failed");
    expect(redirectLocation).toContain("Google+email+claim+is+not+verified");
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(mockClearOAuthCode).toHaveBeenCalledWith("valid-auth-code");
  });

  it("keeps the create path outside Google OAuth emulation", async () => {
    mockIsGoogleOauthEmulationEnabled.mockReturnValue(false);
    mockHandleAccountLinking.mockResolvedValue({
      type: "continue_create",
    });
    const googleClient = {
      verifyIdToken: vi.fn().mockResolvedValue({
        getPayload: () => ({
          sub: "new-provider-account-id",
          email: "user@example.com",
          email_verified: true,
          name: "Test User",
          picture: "https://example.com/avatar.png",
        }),
      }),
      getToken: mockGetToken,
    };
    const { getLinkingOAuth2Client } = await import("@/utils/gmail/client");
    vi.mocked(getLinkingOAuth2Client).mockReturnValue(googleClient as never);

    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );

    const redirectLocation = response.headers.get("location");
    expect(redirectLocation).toContain("success=account_created_and_linked");
    expect(prisma.account.create).toHaveBeenCalled();
    expectReplyTrackingOn(
      prisma.account.create.mock.calls[0]?.[0].data.emailAccount?.create?.rules,
    );
    expect(logFirstSignIn).toHaveBeenCalledWith("email-account-new");
    expect(prisma.account.update).not.toHaveBeenCalled();
    expect(connectCalendarAtSignIn).toHaveBeenCalledWith({
      accountId: "account-123",
      logger: expect.anything(),
    });
  });

  it("rejects the callback when the actor differs from the target user", async () => {
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAuth.mockResolvedValue({
      user: {
        id: "actor-user",
      },
      session: { emailOtp: false },
    });
    mockValidateOAuthCallback.mockReturnValue({
      success: true,
      targetUserId: "target-user",
      stateNonce: "state-nonce",
      code: "valid-auth-code",
    });
    mockHandleAccountLinking.mockResolvedValue({
      type: "continue_create",
    });

    const response = await GET(
      createRequest("http://localhost:3000/api/google/linking/callback"),
    );

    expect(response.headers.get("location")).toContain("error=invalid_state");
    expect(mockGetToken).not.toHaveBeenCalled();
    expect(mockHandleAccountLinking).not.toHaveBeenCalled();
    const warning = consoleWarn.mock.calls[0]?.[0];
    expect(warning).toContain("OAuth linking callback actor mismatch");
    expect(warning).toContain('"actorUserId": "actor-user"');
    expect(warning).toContain('"targetUserId": "target-user"');
    consoleWarn.mockRestore();
  });

  describe("while the waitlist caps extra mailboxes", () => {
    beforeEach(() => {
      Object.assign(env, { AUTH_WAITLIST_ENABLED: true });
    });
    afterEach(() => {
      Object.assign(env, { AUTH_WAITLIST_ENABLED: undefined });
    });

    // Two auth URLs created at once both pass the check there; the cap has to
    // hold when each callback is about to add the mailbox.
    it("refuses the second of two parallel links that would pass the cap", async () => {
      mockHandleAccountLinking.mockResolvedValue({ type: "continue_create" });
      prisma.emailAccount.count
        .mockResolvedValueOnce(2)
        .mockResolvedValueOnce(3);

      const first = await GET(
        createRequest("http://localhost:3000/api/google/linking/callback"),
      );
      mockValidateOAuthCallback.mockReturnValue({
        success: true,
        targetUserId: "user-123",
        stateNonce: "state-nonce",
        code: "second-auth-code",
      });
      const second = await GET(
        createRequest("http://localhost:3000/api/google/linking/callback"),
      );

      expect(first.headers.get("location")).toContain(
        "success=account_created_and_linked",
      );
      expect(second.headers.get("location")).toContain("error=mailbox_limit");
      expect(prisma.account.create).toHaveBeenCalledTimes(1);
    });

    it("refuses moving another user's mailbox in past the cap", async () => {
      mockHandleAccountLinking.mockResolvedValue({
        type: "merge",
        sourceAccountId: "source-account",
        sourceUserId: "source-user",
      });
      prisma.emailAccount.count.mockResolvedValue(3);
      const { mergeAccount } = await import("@/utils/user/merge-account");

      const response = await GET(
        createRequest("http://localhost:3000/api/google/linking/callback"),
      );

      expect(response.headers.get("location")).toContain("error=mailbox_limit");
      expect(mergeAccount).not.toHaveBeenCalled();
    });

    it("never limits reconnecting a mailbox the user already has", async () => {
      mockHandleAccountLinking.mockResolvedValue({
        type: "update_existing_account",
        existingAccountId: "existing-account-123",
      });
      prisma.emailAccount.count.mockResolvedValue(10);

      const response = await GET(
        createRequest("http://localhost:3000/api/google/linking/callback"),
      );

      expect(response.headers.get("location")).toContain(
        "success=tokens_updated",
      );
    });
  });
});

async function runScheduledAfterCallback() {
  const callback = mockAfter.mock.calls.at(-1)?.[0];
  expect(callback).toBeTypeOf("function");
  await callback();
}
