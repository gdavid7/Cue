import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { handleCalendarCallback } from "./handle-calendar-callback";
import type { CalendarOAuthProvider } from "./oauth-types";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BASE_URL: "https://app.example.com" },
}));
vi.mock("@/utils/oauth/verify", () => ({
  verifyEmailAccountAccess: vi.fn(),
}));
vi.mock("@/utils/redis/oauth-code", () => ({
  acquireOAuthCodeLock: vi.fn(async () => true),
  getOAuthCodeResult: vi.fn(async () => null),
  setOAuthCodeResult: vi.fn(),
  clearOAuthCode: vi.fn(),
}));
vi.mock("./oauth-callback-helpers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./oauth-callback-helpers")>()),
  validateOAuthCallback: vi.fn(async () => ({
    code: "code-1",
    response: NextResponse.redirect("https://app.example.com/calendars"),
    calendarState: {
      emailAccountId: "account-1",
      type: "calendar",
      nonce: "nonce-123",
    },
    redirectUrl: new URL("https://app.example.com/account-1/calendars"),
  })),
}));

const logger = createTestLogger();
const expiresAt = new Date("2026-10-14T18:00:00Z");

describe("handleCalendarCallback", () => {
  let provider: CalendarOAuthProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      name: "google",
      exchangeCodeForTokens: vi.fn(async () => ({
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt,
        email: "student@ucsd.edu",
      })),
      syncCalendars: vi.fn(async () => {}),
    };
  });

  it("repairs an existing connection with the fresh tokens instead of discarding them", async () => {
    prisma.calendarConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      isConnected: false,
    } as never);
    prisma.calendarConnection.update.mockResolvedValue({
      id: "connection-1",
    } as never);

    const response = await handleCalendarCallback(
      new NextRequest("https://app.example.com/api/google/calendar/callback"),
      provider,
      logger,
    );

    expect(prisma.calendarConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        accessToken: "fresh-access",
        refreshToken: "fresh-refresh",
        expiresAt,
        isConnected: true,
      },
    });
    expect(prisma.calendarConnection.create).not.toHaveBeenCalled();
    expect(provider.syncCalendars).toHaveBeenCalledWith(
      "connection-1",
      "fresh-access",
      "fresh-refresh",
      "account-1",
      expiresAt,
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("message"),
    ).toBe("calendar_connected");
  });

  it("creates a connection for a calendar not connected before", async () => {
    prisma.calendarConnection.findFirst.mockResolvedValue(null);
    prisma.calendarConnection.create.mockResolvedValue({
      id: "connection-2",
    } as never);

    const response = await handleCalendarCallback(
      new NextRequest("https://app.example.com/api/google/calendar/callback"),
      provider,
      logger,
    );

    expect(prisma.calendarConnection.create).toHaveBeenCalled();
    expect(provider.syncCalendars).toHaveBeenCalledWith(
      "connection-2",
      "fresh-access",
      "fresh-refresh",
      "account-1",
      expiresAt,
    );
    expect(
      new URL(response.headers.get("location")!).searchParams.get("message"),
    ).toBe("calendar_connected");
  });
});
