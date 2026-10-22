import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/utils/calendar/event-types";

const mocks = vi.hoisted(() => ({
  fetchCalendarEventsInWindow: vi.fn(),
  createCalendarEventProviders: vi.fn(),
  getUserOwnAddresses: vi.fn(),
  countConnectedCalendars: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: mocks.fetchCalendarEventsInWindow,
}));
vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: mocks.createCalendarEventProviders,
}));
vi.mock("@/utils/calendar/connections", () => ({
  countConnectedCalendars: mocks.countConnectedCalendars,
}));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: mocks.getUserOwnAddresses,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});

import { GET } from "./route";

// 10:00 in Lisbon (UTC+1 in summer).
const NOW = new Date("2026-07-15T09:00:00.000Z");

describe("GET /api/user/calendar/upcoming-events?range=today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    mocks.getUserOwnAddresses.mockResolvedValue(["user@example.com"]);
    mocks.countConnectedCalendars.mockResolvedValue(1);
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      events: [],
      complete: true,
    });
  });

  it("reads the user's whole local day from every calendar", async () => {
    await getToday("Europe/Lisbon");

    expect(mocks.fetchCalendarEventsInWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        timeMin: new Date("2026-07-14T23:00:00.000Z"),
        timeMax: new Date("2026-07-15T23:00:00.000Z"),
      }),
    );
    // Calendars are the person's, across accounts, not one mailbox's.
    expect(
      mocks.fetchCalendarEventsInWindow.mock.calls[0][0].ownConnectionsOnly,
    ).toBeFalsy();
  });

  it("returns today's meetings in order, with the people on them and not the user", async () => {
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      complete: true,
      events: [
        event({
          id: "standup",
          title: "Standup",
          startTime: at("08:30"),
          endTime: at("08:45"),
          attendees: [
            { email: "user@example.com", name: "Me" },
            { email: "ana@partner.com", name: "Ana Silva" },
            { email: "ben@partner.com", declined: true },
            { email: "room-1@resource.calendar.google.com", name: "Room 1" },
          ],
        }),
        event({
          id: "review",
          title: "Design review",
          startTime: at("14:00"),
          endTime: at("15:00"),
          eventUrl: "https://calendar.example/review",
          description: "Agenda the strip has no use for",
        }),
      ],
    });

    const body = await (await getToday()).json();

    expect(body).toEqual({
      connected: true,
      more: 0,
      events: [
        {
          id: "standup",
          title: "Standup",
          startTime: at("08:30").toISOString(),
          endTime: at("08:45").toISOString(),
          attendees: [{ email: "ana@partner.com", name: "Ana Silva" }],
        },
        {
          id: "review",
          title: "Design review",
          startTime: at("14:00").toISOString(),
          endTime: at("15:00").toISOString(),
          eventUrl: "https://calendar.example/review",
          attendees: [],
        },
      ],
    });
  });

  it("with two calendar accounts, says whose calendar each meeting is on", async () => {
    const events = [
      event({ id: "work", calendarEmail: "user@work.example" }),
      event({ id: "home", calendarEmail: "user@example.com" }),
    ];
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      complete: true,
      events,
    });

    mocks.countConnectedCalendars.mockResolvedValue(1);
    const one = await (await getToday()).json();
    mocks.countConnectedCalendars.mockResolvedValue(2);
    const two = await (await getToday()).json();

    expect(
      one.events.map((e: { calendarEmail?: string }) => e.calendarEmail),
    ).toEqual([undefined, undefined]);
    expect(
      two.events.map((e: { calendarEmail?: string }) => e.calendarEmail),
    ).toEqual(["user@work.example", "user@example.com"]);
  });

  it("leaves out all-day entries and meetings the user declined on any of their addresses", async () => {
    mocks.getUserOwnAddresses.mockResolvedValue([
      "user@example.com",
      "user@work.example",
    ]);
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      complete: true,
      events: [
        event({ id: "holiday", allDay: true }),
        event({
          id: "declined",
          attendees: [{ email: "USER@work.example", declined: true }],
        }),
        event({
          id: "declined-on-calendar",
          calendarEmail: "cal@other.example",
          attendees: [{ email: "cal@other.example", declined: true }],
        }),
        event({ id: "kept" }),
      ],
    });

    const body = await (await getToday()).json();

    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["kept"]);
  });

  it("caps the day at eight, dropping meetings already over before ones to come", async () => {
    const hours = ["07", "08", "09", "10", "11", "12", "13", "14", "15", "16"];
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      complete: true,
      events: hours.map((hour) =>
        event({
          id: `m${hour}`,
          startTime: at(`${hour}:00`),
          endTime: at(`${hour}:30`),
        }),
      ),
    });

    const body = await (await getToday()).json();

    expect(body.events.map((e: { id: string }) => e.id)).toEqual([
      "m09",
      "m10",
      "m11",
      "m12",
      "m13",
      "m14",
      "m15",
      "m16",
    ]);
    expect(body.more).toBe(2);
  });

  it("says when no calendar is connected", async () => {
    mocks.fetchCalendarEventsInWindow.mockResolvedValue({
      events: [],
      complete: false,
      noCalendarConnected: true,
    });

    const body = await (await getToday()).json();

    expect(body).toEqual({ connected: false, events: [], more: 0 });
  });

  it("still lists the next few upcoming events for briefs without a range", async () => {
    const fetchEvents = vi.fn().mockResolvedValue([event({ id: "next" })]);
    mocks.createCalendarEventProviders.mockResolvedValue([{ fetchEvents }]);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/user/calendar/upcoming-events",
      ),
      {} as never,
    );
    const body = await response.json();

    expect(fetchEvents).toHaveBeenCalledWith({ maxResults: 3 });
    expect(body.events.map((e: { id: string }) => e.id)).toEqual(["next"]);
    expect(mocks.fetchCalendarEventsInWindow).not.toHaveBeenCalled();
  });
});

function getToday(timeZone = "UTC") {
  return GET(
    new NextRequest(
      `http://localhost:3000/api/user/calendar/upcoming-events?range=today&tz=${encodeURIComponent(timeZone)}`,
    ),
    {} as never,
  );
}

/** A UTC time on the test's day. */
function at(time: string) {
  return new Date(`2026-07-15T${time}:00.000Z`);
}

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "event",
    title: "Meeting",
    startTime: at("12:00"),
    endTime: at("12:30"),
    attendees: [],
    ...overrides,
  };
}
