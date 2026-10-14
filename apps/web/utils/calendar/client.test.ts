import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth, calendar } from "@googleapis/calendar";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import { SafeError } from "@/utils/error";
import {
  getGoogleApiRootUrl,
  getGoogleOauthClientOptions,
} from "@/utils/gmail/oauth";

vi.mock("@/utils/prisma");

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));

vi.mock("@/utils/gmail/oauth", () => ({
  getGoogleApiRootUrl: vi.fn(() => "http://localhost:4444"),
  getGoogleOauthClientOptions: vi.fn((redirectUri?: string) => ({
    clientId: "client-id",
    clientSecret: "client-secret",
    redirectUri,
    endpoints: {
      oauth2TokenUrl: "http://localhost:4444/oauth2/token",
    },
  })),
}));

const setCredentials = vi.fn();
const refreshAccessToken = vi.fn();
const logger = createTestLogger();

vi.mock("@googleapis/calendar", () => ({
  auth: {
    OAuth2: vi.fn(function OAuth2() {
      return {
        setCredentials,
        refreshAccessToken,
      };
    }),
  },
  calendar: vi.fn(),
}));

describe("google calendar client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 1 } as any);
  });

  it("saves refreshed tokens to the requested calendar connection", async () => {
    const expectedExpiresAt = Date.now() - 1000;
    const refreshedExpiresAt = Date.now() + 3_600_000;
    refreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        expiry_date: refreshedExpiresAt,
      },
    });
    vi.mocked(prisma.calendarConnection.findFirst).mockResolvedValue({
      id: "first-google-connection-id",
    } as any);

    await getCalendarClientWithRefresh({
      accessToken: "stale-access-token",
      refreshToken: "target-refresh-token",
      expiresAt: expectedExpiresAt,
      emailAccountId: "email-account-id",
      connectionId: "target-google-connection-id",
      logger,
    });

    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "target-google-connection-id",
        expiresAt: {
          gte: new Date(expectedExpiresAt),
          lt: new Date(expectedExpiresAt + 1),
        },
      },
      data: {
        accessToken: "new-access-token",
        refreshToken: undefined,
        expiresAt: new Date(refreshedExpiresAt),
      },
    });
    expect(prisma.calendarConnection.update).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.findFirst).not.toHaveBeenCalled();
  });

  it("matches the calendar connection by refresh token when no connection id is provided", async () => {
    const refreshedExpiresAt = Date.now() + 3_600_000;
    refreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        expiry_date: refreshedExpiresAt,
      },
    });
    vi.mocked(prisma.calendarConnection.findFirst).mockResolvedValue({
      id: "target-google-connection-id",
    } as any);

    await getCalendarClientWithRefresh({
      accessToken: "stale-access-token",
      refreshToken: "target-refresh-token",
      expiresAt: Date.now() - 1000,
      emailAccountId: "email-account-id",
      logger,
    });

    expect(prisma.calendarConnection.findFirst).toHaveBeenCalledWith({
      where: {
        emailAccountId: "email-account-id",
        provider: "google",
        refreshToken: "target-refresh-token",
      },
      select: { id: true },
    });
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "target-google-connection-id" }),
      }),
    );
  });

  it("skips stale Google calendar token saves when another refresh already won", async () => {
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 0 } as any);
    refreshAccessToken.mockResolvedValue({
      credentials: {
        access_token: "new-access-token",
        expiry_date: Date.now() + 3_600_000,
      },
    });

    await getCalendarClientWithRefresh({
      accessToken: "stale-access-token",
      refreshToken: "target-refresh-token",
      expiresAt: Date.now() - 1000,
      emailAccountId: "email-account-id",
      connectionId: "target-google-connection-id",
      logger,
    });

    expect(prisma.calendarConnection.update).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledOnce();
  });

  it("marks the connection disconnected and asks for a reconnect when Google revoked it", async () => {
    refreshAccessToken.mockRejectedValue(new Error("invalid_grant"));

    const error = await getCalendarClientWithRefresh({
      accessToken: "stale-access-token",
      refreshToken: "dead-refresh-token",
      expiresAt: Date.now() - 1000,
      emailAccountId: "email-account-id",
      connectionId: "google-connection-id",
      logger,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(SafeError);
    expect(error.message).toContain("reconnect your calendar");
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "google-connection-id", isConnected: true },
      data: { isConnected: false },
    });
  });

  it("finds the revoked connection by its refresh token when no id is given", async () => {
    refreshAccessToken.mockRejectedValue(new Error("invalid_grant"));
    prisma.calendarConnection.findMany.mockResolvedValue([
      { id: "other", refreshToken: "live-refresh-token" },
      { id: "dead", refreshToken: "dead-refresh-token" },
    ] as never);

    await expect(
      getCalendarClientWithRefresh({
        accessToken: "stale-access-token",
        refreshToken: "dead-refresh-token",
        expiresAt: Date.now() - 1000,
        emailAccountId: "email-account-id",
        logger,
      }),
    ).rejects.toBeInstanceOf(SafeError);

    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: { id: "dead", isConnected: true },
      data: { isConnected: false },
    });
  });

  it("uses emulator-aware OAuth and Calendar API options", async () => {
    await getCalendarClientWithRefresh({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 3_600_000,
      emailAccountId: "email-account-id",
      logger,
    });

    expect(getGoogleOauthClientOptions).toHaveBeenCalledWith();
    expect(auth.OAuth2).toHaveBeenCalledWith({
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: undefined,
      endpoints: {
        oauth2TokenUrl: "http://localhost:4444/oauth2/token",
      },
    });
    expect(getGoogleApiRootUrl).toHaveBeenCalledWith();
    expect(calendar).toHaveBeenCalledWith({
      version: "v3",
      auth: expect.any(Object),
      rootUrl: "http://localhost:4444",
    });
  });
});
