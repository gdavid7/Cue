import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { countConnectedCalendars } from "@/utils/calendar/connections";

vi.mock("@/utils/calendar/connections", () => ({
  countConnectedCalendars: vi.fn(),
}));

vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: vi.fn(),
}));

const logger = createTestLogger();

const fetchParams = {
  emailAccountId: "account-1",
  timeMin: new Date("2026-07-29T10:00:00.000Z"),
  timeMax: new Date("2026-07-29T11:00:00.000Z"),
  maxResultsPerProvider: 50,
  logger,
};

describe("fetchCalendarEventsInWindow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(countConnectedCalendars).mockResolvedValue(1);
  });

  it("reports incomplete when no provider could be created", async () => {
    // Connections with a missing refresh token or a failed construction are
    // silently skipped, so an empty provider list proves nothing about the
    // calendar. Complete here would cancel every booked bot.
    vi.mocked(createCalendarEventProviders).mockResolvedValue([]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result).toEqual({
      events: [],
      complete: false,
      noCalendarConnected: false,
    });
  });

  it("says when no calendar is connected at all", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(0);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result).toEqual({
      events: [],
      complete: false,
      noCalendarConnected: true,
    });
  });

  it("reports incomplete when fewer providers were built than calendars are connected", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("event-1")]),
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result.complete).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  it("reports incomplete when a provider fetch fails", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("event-1")]),
      {
        fetchEvents: vi.fn().mockRejectedValue(new Error("provider down")),
      } as never,
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result.complete).toBe(false);
    expect(result.events).toHaveLength(1);
  });

  it("reports complete when every connected calendar was fetched", async () => {
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("event-1")]),
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result.complete).toBe(true);
    expect(result.events.map((event) => event.id)).toEqual(["event-1"]);
  });

  it("shows a meeting the person was invited to on two of their calendars once", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("work-copy"), makeEvent("work-only", "Retro")]),
      fakeProvider([makeEvent("personal-copy")]),
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result.events.map((event) => event.id).sort()).toEqual([
      "work-copy",
      "work-only",
    ]);
    expect(createCalendarEventProviders).toHaveBeenCalledWith(
      "account-1",
      logger,
      { ownConnectionsOnly: false },
    );
  });

  it("keeps the copy of a shared meeting the person didn't decline", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider(
        [
          {
            ...makeEvent("personal-copy"),
            attendees: [{ email: "me@personal.example", declined: true }],
          },
        ],
        "me@personal.example",
      ),
      fakeProvider(
        [
          {
            ...makeEvent("work-copy"),
            attendees: [{ email: "me@work.example", self: true }],
          },
        ],
        "me@work.example",
      ),
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(result.events.map((event) => event.id)).toEqual(["work-copy"]);
  });

  it("keeps the accepted copy when the other was declined at one of the person's aliases", async () => {
    // An Outlook invite to an alias: the alias isn't the calendar's address,
    // only the caller's own-address set knows it is the person.
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider(
        [
          {
            ...makeEvent("outlook-copy"),
            attendees: [{ email: "me.alias@outlook.example", declined: true }],
          },
        ],
        "me@outlook.example",
      ),
      fakeProvider(
        [
          {
            ...makeEvent("gmail-copy"),
            attendees: [{ email: "me@gmail.example" }],
          },
        ],
        "me@gmail.example",
      ),
    ]);

    const result = await fetchCalendarEventsInWindow({
      ...fetchParams,
      selfAddresses: Promise.resolve(
        new Set(["me.alias@outlook.example", "me@gmail.example"]),
      ),
    });

    expect(result.events.map((event) => event.id)).toEqual(["gmail-copy"]);
  });

  it("says which calendar account each event was read from", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("work", "Standup")], "me@work.example"),
      fakeProvider([makeEvent("home", "Dentist")], "me@outlook.example"),
    ]);

    const result = await fetchCalendarEventsInWindow(fetchParams);

    expect(
      Object.fromEntries(
        result.events.map((event) => [event.id, event.calendarEmail]),
      ),
    ).toEqual({ work: "me@work.example", home: "me@outlook.example" });
  });

  it("keeps every copy for automations reading only the account's own calendars", async () => {
    vi.mocked(countConnectedCalendars).mockResolvedValue(2);
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      fakeProvider([makeEvent("work-copy")]),
      fakeProvider([makeEvent("personal-copy")]),
    ]);

    const result = await fetchCalendarEventsInWindow({
      ...fetchParams,
      ownConnectionsOnly: true,
    });

    expect(result.events).toHaveLength(2);
    expect(createCalendarEventProviders).toHaveBeenCalledWith(
      "account-1",
      logger,
      { ownConnectionsOnly: true },
    );
  });
});

function makeEvent(id: string, title = "Planning"): CalendarEvent {
  return {
    id,
    title,
    startTime: new Date("2026-07-29T10:30:00.000Z"),
    endTime: new Date("2026-07-29T10:55:00.000Z"),
    attendees: [],
  } as unknown as CalendarEvent;
}

function fakeProvider(events: CalendarEvent[], calendarEmail?: string) {
  return {
    calendarEmail,
    fetchEvents: vi.fn().mockResolvedValue(events),
  } as never;
}
