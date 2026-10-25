import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { CalendarEvent } from "@/utils/calendar/event-types";

const mocks = vi.hoisted(() => ({
  getUnifiedCalendarAvailability: vi.fn(),
  fetchCalendarEventsInWindow: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/calendar/unified-availability", () => ({
  getUnifiedCalendarAvailability: mocks.getUnifiedCalendarAvailability,
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: mocks.fetchCalendarEventsInWindow,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});

import { GET } from "./route";

const START = "2030-03-04T10:00:00.000Z";
const END = "2030-03-04T11:00:00.000Z";

describe("GET /api/user/calendar/conflicts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.calendar.findMany.mockResolvedValue([
      { calendarId: "primary", connection: { provider: "google" } },
    ] as never);
    mocks.getUnifiedCalendarAvailability.mockResolvedValue([]);
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      events: [],
      complete: true,
    });
  });

  it("names the events that overlap the invitation", async () => {
    busy("2030-03-04T10:30:00.000Z", "2030-03-04T12:00:00.000Z");
    events([
      event({
        title: "Design review",
        startTime: new Date("2030-03-04T10:30:00.000Z"),
        endTime: new Date("2030-03-04T11:30:00.000Z"),
      }),
      event({
        title: "Lunch",
        startTime: new Date("2030-03-04T11:00:00.000Z"),
        endTime: new Date("2030-03-04T12:00:00.000Z"),
      }),
    ]);

    const response = await get({ start: START, end: END });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // Lunch only touches the invitation's end, so it isn't in the way.
    expect(await response.json()).toEqual({
      status: "ok",
      conflicts: [
        {
          title: "Design review",
          start: "2030-03-04T10:30:00.000Z",
          end: "2030-03-04T11:30:00.000Z",
        },
      ],
    });
    // Read live from every calendar the person uses, never one that failed.
    expect(mocks.getUnifiedCalendarAvailability).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        failClosed: true,
      }),
    );
    expect(mocks.fetchCalendarEventsInWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        timeMin: new Date(START),
        timeMax: new Date(END),
      }),
    );
  });

  it("is free when nothing on the calendars is busy then", async () => {
    // Marked free on the calendar, so not busy.
    events([event({ title: "Focus time" })]);

    const response = await get({ start: START, end: END });

    expect(await response.json()).toEqual({ status: "ok", conflicts: [] });
  });

  it("does not count the invitation's own event, matched by its UID", async () => {
    busy(START, END);
    events([event({ title: "Project planning", iCalUid: "invite-uid-1" })]);

    const response = await get({ start: START, end: END, uid: "invite-uid-1" });

    expect(await response.json()).toEqual({ status: "ok", conflicts: [] });
  });

  it("skips declined and all-day events", async () => {
    busy(START, END);
    events([
      event({
        title: "Declined sync",
        attendees: [{ email: "user@example.com", self: true, declined: true }],
      }),
      event({
        title: "Offsite",
        allDay: true,
        startTime: new Date("2030-03-04T00:00:00.000Z"),
        endTime: new Date("2030-03-05T00:00:00.000Z"),
      }),
    ]);

    const response = await get({ start: START, end: END });

    expect(await response.json()).toEqual({ status: "ok", conflicts: [] });
  });

  it("says nothing when no calendar is connected", async () => {
    prisma.calendar.findMany.mockResolvedValue([]);

    const response = await get({ start: START, end: END });

    expect(await response.json()).toEqual({ status: "no-calendar" });
    expect(mocks.getUnifiedCalendarAvailability).not.toHaveBeenCalled();
  });

  it("says nothing when a calendar can't be read", async () => {
    mocks.getUnifiedCalendarAvailability.mockRejectedValue(
      new Error("Calendar read failed"),
    );

    const response = await get({ start: START, end: END });

    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("says nothing when busy time can't be matched to every event", async () => {
    busy(START, END);
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      events: [],
      complete: false,
    });

    const response = await get({ start: START, end: END });

    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it.each([
    ["a missing end", { start: START }],
    ["a time that isn't a date", { start: "tomorrow", end: END }],
    ["an end before the start", { start: END, end: START }],
    ["a window over a day", { start: START, end: "2030-03-05T10:00:01.000Z" }],
  ])("rejects %s", async (_label, params) => {
    const response = await get(params);

    expect(response.status).toBe(400);
    expect(mocks.getUnifiedCalendarAvailability).not.toHaveBeenCalled();
  });
});

function get(params: Record<string, string>) {
  return GET(
    new NextRequest(
      `http://localhost/api/user/calendar/conflicts?${new URLSearchParams(params)}`,
    ),
    {} as never,
  );
}

function busy(start: string, end: string) {
  mocks.getUnifiedCalendarAvailability.mockResolvedValue([{ start, end }]);
}

function events(list: CalendarEvent[]) {
  mocks.fetchCalendarEventsInWindow.mockResolvedValue({
    events: list,
    complete: true,
  });
}

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "event-1",
    title: "Event",
    startTime: new Date(START),
    endTime: new Date(END),
    attendees: [],
    ...overrides,
  };
}
