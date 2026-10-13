import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { SafeError } from "@/utils/error";
import { connectCalendarAtSignIn } from "@/utils/calendar/connect-sign-in-calendar";
import {
  fetchGoogleCalendars,
  getCalendarClientWithRefresh as getGoogleCalendarClient,
} from "@/utils/calendar/client";
import {
  fetchMicrosoftCalendars,
  getCalendarClientWithRefresh as getMicrosoftCalendarClient,
} from "@/utils/outlook/calendar-client";

vi.mock("@/utils/prisma");
vi.mock("@/utils/calendar/client", () => ({
  fetchGoogleCalendars: vi.fn(),
  getCalendarClientWithRefresh: vi.fn(),
  getCalendarOAuth2Client: vi.fn(),
}));
vi.mock("@/utils/outlook/calendar-client", () => ({
  fetchMicrosoftCalendars: vi.fn(),
  getCalendarClientWithRefresh: vi.fn(),
}));
vi.mock("@/utils/calendar/timezone-helpers", () => ({
  autoPopulateTimezone: vi.fn(),
}));

const logger = createTestLogger();
const expiresAt = new Date("2026-10-13T12:00:00Z");

describe("connectCalendarAtSignIn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getGoogleCalendarClient).mockResolvedValue({} as never);
    vi.mocked(getMicrosoftCalendarClient).mockResolvedValue({} as never);
    vi.mocked(fetchGoogleCalendars).mockResolvedValue([
      { id: "primary", summary: "user@example.com", primary: true },
    ]);
    vi.mocked(fetchMicrosoftCalendars).mockResolvedValue([
      { id: "calendar-1", name: "Calendar", isDefaultCalendar: true },
    ] as never);
    prisma.calendarConnection.create.mockResolvedValue({
      id: "connection-1",
    } as never);
  });

  it.each([
    "google",
    "microsoft",
  ])("connects a new %s mailbox's calendar with its sign-in tokens", async (provider) => {
    mockAccount(provider);
    prisma.calendarConnection.findFirst.mockResolvedValue(null);

    await connectCalendarAtSignIn({ accountId: "account-1", logger });

    expect(prisma.calendarConnection.create).toHaveBeenCalledWith({
      data: {
        provider,
        email: "user@example.com",
        emailAccountId: "email-account-1",
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt,
        isConnected: true,
      },
    });
    expect(prisma.calendar.upsert).toHaveBeenCalledOnce();
    const upsert = prisma.calendar.upsert.mock.calls[0][0];
    expect(upsert.where.connectionId_calendarId?.connectionId).toBe(
      "connection-1",
    );
    expect(upsert.create.isEnabled).toBe(true);
    expect(prisma.calendarConnection.deleteMany).not.toHaveBeenCalled();
  });

  it("never re-enables a calendar the person turned off", async () => {
    mockAccount("google");
    prisma.calendarConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      isConnected: false,
    } as never);

    await connectCalendarAtSignIn({ accountId: "account-1", logger });

    const upsert = prisma.calendar.upsert.mock.calls[0][0];
    expect(upsert.update).not.toHaveProperty("isEnabled");
  });

  it("leaves a working connection and its own grant alone on re-sign-in", async () => {
    mockAccount("google");
    prisma.calendarConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      isConnected: true,
    } as never);

    await connectCalendarAtSignIn({ accountId: "account-1", logger });

    expect(prisma.calendarConnection.create).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.update).not.toHaveBeenCalled();
    expect(fetchGoogleCalendars).not.toHaveBeenCalled();
  });

  it("revives a disconnected connection with the fresh sign-in tokens", async () => {
    mockAccount("google");
    prisma.calendarConnection.findFirst.mockResolvedValue({
      id: "connection-1",
      isConnected: false,
    } as never);

    await connectCalendarAtSignIn({ accountId: "account-1", logger });

    expect(prisma.calendarConnection.create).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-1" },
      data: {
        accessToken: "access-token",
        refreshToken: "refresh-token",
        expiresAt,
        isConnected: true,
      },
    });
    expect(prisma.calendar.upsert).toHaveBeenCalledOnce();
  });

  it("removes the new connection, without throwing, when the grant has no calendar access", async () => {
    mockAccount("google");
    prisma.calendarConnection.findFirst.mockResolvedValue(null);
    vi.mocked(fetchGoogleCalendars).mockRejectedValue(
      new SafeError("Failed to fetch calendars"),
    );

    await expect(
      connectCalendarAtSignIn({ accountId: "account-1", logger }),
    ).resolves.toBeUndefined();

    expect(prisma.calendarConnection.deleteMany).toHaveBeenCalledWith({
      where: { id: "connection-1" },
    });
  });

  it("does not fail sign-in when the database errors", async () => {
    prisma.account.findUnique.mockRejectedValue(new Error("db down"));

    await expect(
      connectCalendarAtSignIn({ accountId: "account-1", logger }),
    ).resolves.toBeUndefined();
  });

  it("does nothing for an account without a mailbox", async () => {
    prisma.account.findUnique.mockResolvedValue({
      provider: "apple",
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_at: expiresAt,
      emailAccount: null,
    } as never);

    await connectCalendarAtSignIn({ accountId: "account-1", logger });

    expect(prisma.calendarConnection.findFirst).not.toHaveBeenCalled();
    expect(prisma.calendarConnection.create).not.toHaveBeenCalled();
  });
});

function mockAccount(provider: string) {
  prisma.account.findUnique.mockResolvedValue({
    provider,
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_at: expiresAt,
    emailAccount: { id: "email-account-1", email: "user@example.com" },
  } as never);
}
