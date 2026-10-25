import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { requestMicrosoftToken } from "@/utils/outlook/oauth";
import { createTestLogger } from "@/__tests__/helpers";
import { getCalendarClientWithRefresh } from "./calendar-client";

vi.mock("@/utils/outlook/client", () => ({
  createMicrosoftGraphClient: vi.fn(() => ({})),
}));

vi.mock("@/utils/prisma");

vi.mock("@/utils/outlook/oauth", () => ({
  getMicrosoftGraphClientOptions: vi.fn(() => ({
    baseUrl: "http://localhost:4003/",
  })),
  getMicrosoftOauthAuthorizeUrl: vi.fn(
    () => "http://localhost:4003/oauth2/v2.0/authorize",
  ),
  requestMicrosoftToken: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    MICROSOFT_CLIENT_ID: "client-id",
    MICROSOFT_CLIENT_SECRET: "client-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));

describe("getCalendarClientWithRefresh token save concurrency", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(requestMicrosoftToken).mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 3600,
      }),
    } as any);
  });

  it("saves refreshed and rotated Microsoft calendar tokens with optimistic concurrency", async () => {
    const expectedExpiresAt = 1_700_000_000_000;
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 1 } as any);

    await getCalendarClientWithRefresh({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: expectedExpiresAt,
      connectionId: "calendar-connection-id",
      logger: createTestLogger(),
    });

    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "calendar-connection-id",
        expiresAt: {
          gte: new Date(expectedExpiresAt),
          lt: new Date(expectedExpiresAt + 1),
        },
      },
      data: {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: expect.any(Date),
      },
    });
    expect(prisma.calendarConnection.update).not.toHaveBeenCalled();
  });

  it("skips stale Microsoft calendar token saves when a concurrent refresh already won", async () => {
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 0 } as any);

    await getCalendarClientWithRefresh({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: 1_700_000_000_000,
      connectionId: "calendar-connection-id",
      logger: createTestLogger(),
    });

    expect(prisma.calendarConnection.update).not.toHaveBeenCalled();
  });
  it("writes refreshed tokens to the connection that was refreshed, not another Microsoft connection", async () => {
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 1 } as any);

    await getCalendarClientWithRefresh({
      accessToken: "second-access-token",
      refreshToken: "second-refresh-token",
      expiresAt: null,
      connectionId: "second-connection-id",
      logger: createTestLogger(),
    });

    expect(prisma.calendarConnection.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "second-connection-id" }),
      }),
    );
  });

  it("keeps the stored refresh token when Microsoft does not rotate it", async () => {
    vi.mocked(requestMicrosoftToken).mockResolvedValue(
      Response.json({ access_token: "new-access-token", expires_in: 3600 }),
    );
    prisma.calendarConnection.updateMany.mockResolvedValue({ count: 1 } as any);

    await getCalendarClientWithRefresh({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: null,
      connectionId: "calendar-connection-id",
      logger: createTestLogger(),
    });

    const { data } = prisma.calendarConnection.updateMany.mock.calls[0][0];
    expect(data).toMatchObject({ accessToken: "new-access-token" });
    expect(data?.refreshToken).toBeUndefined();
  });
});
