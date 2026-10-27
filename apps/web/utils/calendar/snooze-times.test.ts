import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { DEFAULT_WEEKDAY_WINDOWS } from "@/utils/booking/default-availability";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { readFreeTimeAvailability } from "@/utils/calendar/free-times";
import {
  getSnoozeTimes,
  resolveAfterNextMeeting,
  resolveNextFreeHour,
} from "@/utils/calendar/snooze-times";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(),
}));
vi.mock("@/utils/calendar/free-times", () => ({
  readFreeTimeAvailability: vi.fn(),
}));
vi.mock("@/utils/calendar/meeting-rules", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/calendar/meeting-rules")>()),
  getCalendarAccounts: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: vi.fn().mockResolvedValue([]),
}));

const SELF = new Set(["me@example.com"]);
// Friday, Oct 23 2026, 10:00 in New York (EDT, UTC-4).
const NOW = new Date("2026-10-23T14:00:00Z");

describe("resolveAfterNextMeeting", () => {
  it("has nothing without events", () => {
    expect(resolveAfterNextMeeting({ events: [], now: NOW, self: SELF })).toBe(
      null,
    );
  });

  it("passes over a meeting already in progress for the next one", () => {
    const events = [
      meeting("2026-10-23T13:45:00Z", "2026-10-23T14:15:00Z"),
      meeting("2026-10-23T15:00:00Z", "2026-10-23T15:30:00Z"),
    ];

    expect(resolveAfterNextMeeting({ events, now: NOW, self: SELF })).toEqual(
      new Date("2026-10-23T15:30:00Z"),
    );
    expect(
      resolveAfterNextMeeting({ events: [events[0]], now: NOW, self: SELF }),
    ).toBe(null);
  });

  it("ends with the first of back-to-back meetings", () => {
    const events = [
      meeting("2026-10-23T14:30:00Z", "2026-10-23T15:00:00Z"),
      meeting("2026-10-23T14:00:00Z", "2026-10-23T14:30:00Z"),
    ];

    expect(resolveAfterNextMeeting({ events, now: NOW, self: SELF })).toEqual(
      new Date("2026-10-23T14:30:00Z"),
    );
  });

  it("skips all-day events", () => {
    const events = [
      {
        ...meeting("2026-10-24T00:00:00Z", "2026-10-25T00:00:00Z"),
        allDay: true,
      },
      meeting("2026-10-23T16:00:00Z", "2026-10-23T17:00:00Z"),
    ];

    expect(resolveAfterNextMeeting({ events, now: NOW, self: SELF })).toEqual(
      new Date("2026-10-23T17:00:00Z"),
    );
  });

  it("skips a meeting the user declined", () => {
    const events = [
      {
        ...meeting("2026-10-23T14:30:00Z", "2026-10-23T15:00:00Z"),
        attendees: [{ email: "Me@Example.com", declined: true }],
      },
      meeting("2026-10-23T16:00:00Z", "2026-10-23T16:30:00Z"),
    ];

    expect(resolveAfterNextMeeting({ events, now: NOW, self: SELF })).toEqual(
      new Date("2026-10-23T16:30:00Z"),
    );
  });

  it("only looks at meetings starting within the next 8 hours", () => {
    const atEightHours = meeting(
      "2026-10-23T22:00:00Z",
      "2026-10-23T22:30:00Z",
    );
    const pastEightHours = meeting(
      "2026-10-23T22:01:00Z",
      "2026-10-23T22:30:00Z",
    );

    expect(
      resolveAfterNextMeeting({ events: [atEightHours], now: NOW, self: SELF }),
    ).toEqual(new Date("2026-10-23T22:30:00Z"));
    expect(
      resolveAfterNextMeeting({
        events: [pastEightHours],
        now: NOW,
        self: SELF,
      }),
    ).toBe(null);
  });
});

describe("resolveNextFreeHour", () => {
  const newYork = {
    timezone: "America/New_York",
    rules: DEFAULT_WEEKDAY_WINDOWS,
    searchDays: 14,
  };

  it("starts at the next half hour when the hour after it is free", () => {
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: new Date("2026-10-23T14:10:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-23T14:30:00Z"));
  });

  it("never resolves to now itself", () => {
    expect(
      resolveNextFreeHour({ ...newYork, now: NOW, busyPeriods: [] }),
    ).toEqual(new Date("2026-10-23T14:30:00Z"));
  });

  it("waits for working hours to begin", () => {
    // 7:00 in New York.
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: new Date("2026-10-23T11:00:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-23T13:00:00Z"));
  });

  it("skips openings shorter than an hour", () => {
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: NOW,
        busyPeriods: [
          { start: "2026-10-23T14:00:00Z", end: "2026-10-23T15:00:00Z" },
          // Free 11:00-11:30 only.
          { start: "2026-10-23T15:30:00Z", end: "2026-10-23T17:00:00Z" },
        ],
      }),
    ).toEqual(new Date("2026-10-23T17:00:00Z"));
  });

  it("fits an hour that ends exactly when working hours do", () => {
    // 15:45 in New York: 16:00-17:00 still fits.
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: new Date("2026-10-23T19:45:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-23T20:00:00Z"));
  });

  it("moves to the next working day once the hour no longer fits today", () => {
    // Friday 16:10 in New York: next is Monday 9:00, still on EDT.
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: new Date("2026-10-16T20:10:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-19T13:00:00Z"));
  });

  it("keeps 9:00 local across a daylight saving change", () => {
    // Friday Oct 30 16:30 EDT; clocks fall back on Sunday Nov 1, so Monday
    // 9:00 is 14:00 UTC, an hour later than the week before.
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: new Date("2026-10-30T20:30:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-11-02T14:00:00Z"));
  });

  it("reads working hours in the account's own time zone", () => {
    // 14:00 UTC is 15:00 in London (GMT after Oct 25): free from 15:30, the
    // next half hour, though New York's day has only just begun.
    expect(
      resolveNextFreeHour({
        ...newYork,
        timezone: "Europe/London",
        now: new Date("2026-10-27T14:10:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-27T14:30:00Z"));
    // 16:10 in London: nothing left today, so 9:00 tomorrow.
    expect(
      resolveNextFreeHour({
        ...newYork,
        timezone: "Europe/London",
        now: new Date("2026-10-27T16:10:00Z"),
        busyPeriods: [],
      }),
    ).toEqual(new Date("2026-10-28T09:00:00Z"));
  });

  it("has nothing when the whole search is busy", () => {
    expect(
      resolveNextFreeHour({
        ...newYork,
        now: NOW,
        busyPeriods: [
          { start: "2026-10-23T00:00:00Z", end: "2026-11-10T00:00:00Z" },
        ],
      }),
    ).toBe(null);
    expect(
      resolveNextFreeHour({ ...newYork, rules: [], now: NOW, busyPeriods: [] }),
    ).toBe(null);
  });
});

describe("getSnoozeTimes", () => {
  const fetchEvents = vi.mocked(fetchCalendarEventsInWindow);
  const readAvailability = vi.mocked(readFreeTimeAvailability);
  const read = () =>
    getSnoozeTimes({
      emailAccountId: "account",
      userId: "user",
      email: "me@example.com",
      now: NOW,
      logger: createTestLogger(),
    });

  beforeEach(() => {
    vi.clearAllMocks();
    fetchEvents.mockResolvedValue({
      complete: true,
      events: [meeting("2026-10-23T15:00:00Z", "2026-10-23T15:30:00Z")],
    } as never);
    readAvailability.mockResolvedValue({
      status: "ok",
      timezone: "America/New_York",
      rules: DEFAULT_WEEKDAY_WINDOWS,
      searchDays: 14,
      busyPeriods: [
        { start: "2026-10-23T15:00:00Z", end: "2026-10-23T15:30:00Z" },
      ],
    } as never);
  });

  it("returns both times when the calendar answers", async () => {
    expect(await read()).toEqual({
      afterNextMeeting: "2026-10-23T15:30:00.000Z",
      nextFreeHour: "2026-10-23T15:30:00.000Z",
    });
  });

  it("offers nothing without a connected calendar", async () => {
    fetchEvents.mockResolvedValue({
      complete: false,
      events: [],
      noCalendarConnected: true,
    });
    readAvailability.mockResolvedValue({
      status: "no-calendar",
      bookingLink: null,
    });

    expect(await read()).toEqual({
      afterNextMeeting: null,
      nextFreeHour: null,
    });
  });

  it("leaves out the next meeting when a calendar didn't answer", async () => {
    fetchEvents.mockResolvedValue({
      complete: false,
      events: [meeting("2026-10-23T15:00:00Z", "2026-10-23T15:30:00Z")],
    } as never);

    expect((await read()).afterNextMeeting).toBe(null);
  });

  it("keeps one time when reading the other fails", async () => {
    readAvailability.mockRejectedValue(new Error("calendar down"));

    expect(await read()).toEqual({
      afterNextMeeting: "2026-10-23T15:30:00.000Z",
      nextFreeHour: null,
    });
  });
});

function meeting(
  start: string,
  end: string,
): Pick<CalendarEvent, "allDay" | "attendees" | "endTime" | "startTime"> {
  return {
    startTime: new Date(start),
    endTime: new Date(end),
    attendees: [{ email: "me@example.com" }, { email: "them@example.com" }],
  };
}
