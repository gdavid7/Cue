import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { checkPermissionsAction } from "@/utils/actions/permissions";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const { mockGetTokens, mockHandleGmailPermissionsCheck } = vi.hoisted(() => ({
  mockGetTokens: vi.fn(),
  mockHandleGmailPermissionsCheck: vi.fn(),
}));

vi.mock("@/utils/email-account-client", () => ({
  getGmailAndAccessTokenForEmail: mockGetTokens,
  getOutlookClientForEmail: vi.fn(),
}));
vi.mock("@/utils/gmail/permissions", () => ({
  handleGmailPermissionsCheck: mockHandleGmailPermissionsCheck,
}));

const EMAIL_ACCOUNT_ID = "email-account-1";

// `hasRefreshToken: false` is what sends people to "Sign in again" rather
// than to the missing-permissions list.
describe("checkPermissionsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }) as never,
    );
  });

  it("reports an expired sign-in when the refresh token was cleared", async () => {
    mockGetTokens.mockResolvedValue({
      accessToken: null,
      tokens: { refreshToken: null },
    });

    const result = await checkPermissionsAction(EMAIL_ACCOUNT_ID);

    expect(result?.data).toEqual({
      hasRefreshToken: false,
      hasAllPermissions: false,
    });
  });

  it("reports an expired sign-in when Google rejects the refresh token", async () => {
    mockGetTokens.mockResolvedValue({
      accessToken: "access",
      tokens: { refreshToken: "refresh" },
    });
    mockHandleGmailPermissionsCheck.mockResolvedValue({
      hasAllPermissions: false,
      error: "Gmail access expired. Please reconnect your account.",
    });

    const result = await checkPermissionsAction(EMAIL_ACCOUNT_ID);

    expect(result?.data?.hasRefreshToken).toBe(false);
  });

  it("reports missing permissions while the sign-in is still valid", async () => {
    mockGetTokens.mockResolvedValue({
      accessToken: "access",
      tokens: { refreshToken: "refresh" },
    });
    mockHandleGmailPermissionsCheck.mockResolvedValue({
      hasAllPermissions: false,
    });

    const result = await checkPermissionsAction(EMAIL_ACCOUNT_ID);

    expect(result?.data).toEqual({
      hasRefreshToken: true,
      hasAllPermissions: false,
    });
  });
});
