import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  addToCalendar,
  resolveEventTimes,
} from "@/utils/calendar/add-to-calendar";
import { createCalendarEvent } from "@/utils/calendar/event-writer";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/calendar/event-writer", () => ({
  createCalendarEvent: vi.fn(),
}));

describe("resolveEventTimes", () => {
  it("spans whole days for a date, through the end date inclusive", () => {
    expect(resolveEventTimes({ start: "2026-10-20" })).toEqual({
      allDay: true,
      startTime: new Date("2026-10-20T00:00:00Z"),
      endTime: new Date("2026-10-21T00:00:00Z"),
    });
    expect(
      resolveEventTimes({ start: "2026-10-20", end: "2026-10-22" }).endTime,
    ).toEqual(new Date("2026-10-23T00:00:00Z"));
  });

  it("gives a timed event an hour unless an end is given", () => {
    expect(resolveEventTimes({ start: "2026-10-20T14:00:00-07:00" })).toEqual({
      allDay: false,
      startTime: new Date("2026-10-20T21:00:00Z"),
      endTime: new Date("2026-10-20T22:00:00Z"),
    });
    expect(
      resolveEventTimes({
        start: "2026-10-20T14:00:00-07:00",
        end: "2026-10-20T14:30:00-07:00",
      }).endTime,
    ).toEqual(new Date("2026-10-20T21:30:00Z"));
  });

  it("refuses a clock time without a zone instead of guessing one", () => {
    expect(() => resolveEventTimes({ start: "2026-10-20T14:00" })).toThrow(
      /UTC offset/,
    );
  });

  it("refuses impossible or backwards times", () => {
    expect(() => resolveEventTimes({ start: "2026-02-30" })).toThrow(
      /not a valid date/,
    );
    expect(() =>
      resolveEventTimes({ start: "2026-10-22", end: "2026-10-20" }),
    ).toThrow(/before the start/);
    expect(() =>
      resolveEventTimes({
        start: "2026-10-20T14:00:00Z",
        end: "2026-10-20T13:00:00Z",
      }),
    ).toThrow(/after the start/);
    expect(() =>
      resolveEventTimes({ start: "2026-10-20", end: "2026-10-21T10:00:00Z" }),
    ).toThrow(/must also be a date/);
  });
});

describe("addToCalendar", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createCalendarEvent).mockResolvedValue({
      id: "event-1",
      providerCalendarId: "primary",
      eventUrl: "https://calendar.google.com/event?eid=1",
      provider: "google",
      providerConnectionId: "connection-1",
    });
  });

  it("creates the item on the user's own calendar with nobody invited", async () => {
    const result = await addToCalendar({
      emailAccountId: "account-1",
      title: "HW 3 due",
      start: "2026-10-20",
      location: "Gradescope",
      timezone: "America/Los_Angeles",
      logger: createTestLogger(),
    });

    expect(createCalendarEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        title: "HW 3 due",
        allDay: true,
        startTime: new Date("2026-10-20T00:00:00Z"),
        endTime: new Date("2026-10-21T00:00:00Z"),
        timezone: "America/Los_Angeles",
        attendees: [],
        locationValue: "Gradescope",
      }),
    );
    expect(result).toEqual({
      title: "HW 3 due",
      allDay: true,
      start: "2026-10-20",
      end: "2026-10-20",
      eventUrl: "https://calendar.google.com/event?eid=1",
    });
  });
});
