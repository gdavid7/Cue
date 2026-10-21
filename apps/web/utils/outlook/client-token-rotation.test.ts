import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { requestMicrosoftToken } from "@/utils/outlook/oauth";
import { getOutlookClientWithRefresh } from "./client";

vi.mock("@/utils/prisma");

vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: { init: vi.fn(), initWithMiddleware: vi.fn() },
  MiddlewareFactory: { getDefaultMiddlewareChain: vi.fn(() => []) },
}));

vi.mock("@/utils/outlook/oauth", () => ({
  getMicrosoftGraphClientOptions: vi.fn(() => ({})),
  getMicrosoftOauthAuthorizeUrl: vi.fn(),
  requestMicrosoftToken: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));

describe("getOutlookClientWithRefresh refresh token rotation", () => {
  const expiredAt = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.account.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailAccount.findUnique.mockResolvedValue(null);
  });

  it("stores the rotated refresh token Microsoft returns on the refreshed account", async () => {
    vi.mocked(requestMicrosoftToken).mockResolvedValue(
      Response.json({
        access_token: "new-access-token",
        refresh_token: "rotated-refresh-token",
        expires_in: 3600,
      }),
    );

    await refreshExpiredMailbox();

    expect(prisma.account.updateMany).toHaveBeenCalledTimes(1);
    const { where, data } = prisma.account.updateMany.mock.calls[0][0];
    expect(where).toMatchObject({
      provider: "microsoft",
      emailAccount: { id: "email-account-id" },
    });
    expect(data).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "rotated-refresh-token",
    });
  });

  it("keeps the stored refresh token when the response omits one", async () => {
    vi.mocked(requestMicrosoftToken).mockResolvedValue(
      Response.json({ access_token: "new-access-token", expires_in: 3600 }),
    );

    await refreshExpiredMailbox();

    const { data } = prisma.account.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "original-refresh-token",
    });
  });

  function refreshExpiredMailbox() {
    return getOutlookClientWithRefresh({
      accessToken: "stale-access-token",
      refreshToken: "original-refresh-token",
      expiresAt: expiredAt,
      emailAccountId: "email-account-id",
      logger: createTestLogger(),
    });
  }
});
