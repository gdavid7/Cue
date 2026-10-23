import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { getUnifiedCalendarAvailability } from "@/utils/calendar/unified-availability";
import { getFreeTimes, pickOpenings } from "@/utils/calendar/free-times";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BASE_URL: "https://cue.example/" },
}));
vi.mock("@/utils/calendar/unified-availability", () => ({
  getUnifiedCalendarAvailability: vi.fn(),
}));

const logger = createTestLogger();
const unifiedAvailability = vi.mocked(getUnifiedCalendarAvailability);
// Friday, Oct 23 2026, 8:00 in New York.
const NOW = new Date("2026-10-23T12:00:00Z");

describe("getFreeTimes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccount({});
    prisma.availabilitySchedule.findFirst.mockResolvedValue(null);
    prisma.calendar.findMany.mockResolvedValue([
      { calendarId: "primary", connection: { provider: "google" } },
    ] as never);
    prisma.booking.findMany.mockResolvedValue([]);
    unifiedAvailability.mockResolvedValue([]);
  });

  it("says no calendar is connected without reading any", async () => {
    prisma.calendar.findMany.mockResolvedValue([]);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });

    expect(result).toEqual({ status: "no-calendar", bookingLink: null });
    expect(unifiedAvailability).not.toHaveBeenCalled();
  });

  it("treats holiday and birthday calendars alone as no calendar", async () => {
    prisma.calendar.findMany.mockResolvedValue([
      {
        calendarId: "en.usa#holiday@group.v.calendar.google.com",
        connection: { provider: "google" },
      },
    ] as never);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });

    expect(result.status).toBe("no-calendar");
  });

  it("offers the first time of each separate opening inside default weekday hours", async () => {
    unifiedAvailability.mockResolvedValue([
      // Friday 10:00-11:00 and Monday 11:00-12:00 in New York.
      { start: "2026-10-23T14:00:00Z", end: "2026-10-23T15:00:00Z" },
      { start: "2026-10-26T15:00:00Z", end: "2026-10-26T16:00:00Z" },
    ]);
    // A booking that hasn't reached the calendar yet holds Friday 11:00.
    prisma.booking.findMany.mockResolvedValue([
      {
        startTime: new Date("2026-10-23T15:00:00Z"),
        endTime: new Date("2026-10-23T15:30:00Z"),
      },
    ] as never);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });

    expect(result).toMatchObject({
      status: "ok",
      timezone: "America/New_York",
      durationMinutes: 30,
      slots: [
        // Friday 11:30, after the notice period and both holds.
        { startTime: "2026-10-23T15:30:00.000Z" },
        // Monday 9:00, then 12:00 after the meeting.
        { startTime: "2026-10-26T13:00:00.000Z" },
        { startTime: "2026-10-26T16:00:00.000Z" },
      ],
    });
  });

  it("reads whole days in the account's zone and refuses to guess past an unreadable calendar", async () => {
    await getFreeTimes({ emailAccountId: "account", now: NOW, logger });

    expect(unifiedAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-10-23",
        endDate: "2026-11-06",
        timezone: "America/New_York",
        failClosed: true,
      }),
    );
  });

  it("keeps 9:00 local across the fall-back DST change", async () => {
    // Friday Oct 30 is fully booked; Monday Nov 2 is after New York falls back.
    unifiedAvailability.mockResolvedValue([
      { start: "2026-10-30T00:00:00Z", end: "2026-10-31T04:00:00Z" },
    ]);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: new Date("2026-10-30T12:00:00Z"),
      logger,
    });

    expect(result.status === "ok" && result.slots[0]).toEqual({
      startTime: "2026-11-02T14:00:00.000Z",
      endTime: "2026-11-02T14:30:00.000Z",
    });
  });

  it("respects saved weekly hours and the booking link's meeting length", async () => {
    mockAccount({
      bookingLinks: [
        { slug: "dana", durationMinutes: 45, minimumNoticeMinutes: 0 },
      ],
    });
    // Tuesdays 13:00-14:00 only: a 45-minute meeting fits once.
    prisma.availabilitySchedule.findFirst.mockResolvedValue({
      windows: [{ weekday: 2, startMinutes: 13 * 60, endMinutes: 14 * 60 }],
    } as never);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });

    expect(result).toEqual({
      status: "ok",
      timezone: "America/New_York",
      durationMinutes: 45,
      searchDays: 14,
      slots: [
        {
          startTime: "2026-10-27T17:00:00.000Z",
          endTime: "2026-10-27T17:45:00.000Z",
        },
        // Nov 3 is after the clock change, so 13:00 is an hour later in UTC.
        {
          startTime: "2026-11-03T18:00:00.000Z",
          endTime: "2026-11-03T18:45:00.000Z",
        },
      ],
      bookingLink: "https://cue.example/book/dana",
    });
  });

  it("returns no slots when the calendar is full for the whole search", async () => {
    unifiedAvailability.mockResolvedValue([
      { start: "2026-10-01T00:00:00Z", end: "2026-12-01T00:00:00Z" },
    ]);

    const result = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });

    expect(result).toMatchObject({ status: "ok", slots: [] });
  });

  it("fails rather than offering times when a calendar can't be read", async () => {
    unifiedAvailability.mockRejectedValue(new Error("token expired"));

    await expect(
      getFreeTimes({ emailAccountId: "account", now: NOW, logger }),
    ).rejects.toMatchObject({ name: "SafeError", statusCode: 503 });
  });

  it("shares a typed-in booking link only when it is a web link", async () => {
    mockAccount({ calendarBookingLink: "javascript:alert(1)" });
    const unsafe = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });
    expect(unsafe.bookingLink).toBeNull();

    mockAccount({ calendarBookingLink: " https://cal.example/dana " });
    const safe = await getFreeTimes({
      emailAccountId: "account",
      now: NOW,
      logger,
    });
    expect(safe.bookingLink).toBe("https://cal.example/dana");
  });
});

describe("pickOpenings", () => {
  it("skips slots that only continue the previous opening", () => {
    const slot = (startTime: string) => ({ startTime, endTime: startTime });
    expect(
      pickOpenings(
        [
          slot("2026-10-26T13:00:00Z"),
          slot("2026-10-26T13:30:00Z"),
          slot("2026-10-26T15:00:00Z"),
          slot("2026-10-26T15:30:00Z"),
          slot("2026-10-27T13:00:00Z"),
          slot("2026-10-28T13:00:00Z"),
        ],
        30,
        3,
      ).map((s) => s.startTime),
    ).toEqual([
      "2026-10-26T13:00:00Z",
      "2026-10-26T15:00:00Z",
      "2026-10-27T13:00:00Z",
    ]);
  });
});

function mockAccount({
  calendarBookingLink = null,
  bookingLinks = [],
}: {
  calendarBookingLink?: string | null;
  bookingLinks?: {
    slug: string;
    durationMinutes: number;
    minimumNoticeMinutes: number;
  }[];
}) {
  prisma.emailAccount.findUnique.mockResolvedValue({
    timezone: "America/New_York",
    calendarBookingLink,
    bookingLinks,
  } as never);
}
