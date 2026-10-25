import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";

const calendarMocks = vi.hoisted(() => ({
  insert: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/utils/calendar/client", () => ({
  getCalendarClientWithRefresh: vi.fn(async () => ({
    events: { insert: calendarMocks.insert, list: calendarMocks.list },
  })),
}));

describe("GoogleCalendarEventProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads past a short page while Google says more events follow", async () => {
    calendarMocks.list
      .mockResolvedValueOnce({
        data: {
          items: [googleEvent("first", "2026-05-04T09:00:00.000Z")],
          nextPageToken: "page-2",
        },
      })
      .mockResolvedValueOnce({
        data: { items: [googleEvent("second", "2026-05-04T09:15:00.000Z")] },
      });

    const events = await createProvider().fetchEvents({
      timeMin: new Date("2026-05-04T09:00:00.000Z"),
      timeMax: new Date("2026-05-04T10:00:00.000Z"),
      maxResults: 50,
    });

    expect(events.map((event) => event.id)).toEqual(["first", "second"]);
    expect(calendarMocks.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ pageToken: "page-2" }),
    );
  });

  it("stops after ten pages and says the list is incomplete", async () => {
    calendarMocks.list.mockImplementation(async ({ pageToken }) => ({
      data: {
        items: [
          googleEvent(`event-${pageToken ?? 0}`, "2026-05-04T09:00:00.000Z"),
        ],
        nextPageToken: `${Number(pageToken ?? 0) + 1}`,
      },
    }));
    const onIncomplete = vi.fn();

    const events = await createProvider().fetchEvents({
      timeMin: new Date("2026-05-04T09:00:00.000Z"),
      timeMax: new Date("2026-05-04T10:00:00.000Z"),
      maxResults: 50,
      onIncomplete,
    });

    expect(calendarMocks.list).toHaveBeenCalledTimes(10);
    expect(events).toHaveLength(10);
    expect(onIncomplete).toHaveBeenCalled();
  });

  it("keeps the busy copy of an event on two of the account's calendars", async () => {
    calendarMocks.list
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...googleEvent("shared", "2026-05-04T09:00:00.000Z"),
              iCalUID: "shared-uid",
              transparency: "transparent",
            },
          ],
        },
      })
      .mockResolvedValueOnce({
        data: {
          items: [
            {
              ...googleEvent("shared", "2026-05-04T09:00:00.000Z"),
              iCalUID: "shared-uid",
            },
          ],
        },
      });

    const events = await createProvider({
      calendarIds: ["team", "primary"],
    }).fetchEvents({ maxResults: 5 });

    expect(events).toHaveLength(1);
    expect(events[0].markedFree).toBeUndefined();
  });

  it("marks events shown as free", async () => {
    calendarMocks.list.mockResolvedValue({
      data: {
        items: [
          {
            ...googleEvent("focus", "2026-05-04T09:00:00.000Z"),
            transparency: "transparent",
          },
        ],
      },
    });

    const [event] = await createProvider().fetchEvents({ maxResults: 5 });

    expect(event.markedFree).toBe(true);
  });

  it("parses the organizer and declined attendees when fetching events", async () => {
    calendarMocks.list.mockResolvedValue({
      data: {
        items: [
          {
            id: "event-id",
            summary: "Sync",
            organizer: { email: "Host@Example.com", self: true },
            start: { dateTime: "2026-05-04T09:00:00.000Z" },
            end: { dateTime: "2026-05-04T09:30:00.000Z" },
            attendees: [
              {
                email: "guest@example.com",
                displayName: "Guest",
                responseStatus: "accepted",
              },
              {
                email: "busy@example.com",
                displayName: "Busy",
                responseStatus: "declined",
              },
              {
                email: "me@example.com",
                self: true,
                responseStatus: "accepted",
              },
              { email: "room@example.com", resource: true },
            ],
          },
        ],
      },
    });

    const provider = createProvider();

    const events = await provider.fetchEvents({
      timeMin: new Date("2026-05-04T00:00:00.000Z"),
      timeMax: new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        isOrganizer: true,
        organizerEmail: "Host@Example.com",
        attendees: [
          { email: "guest@example.com", name: "Guest", declined: false },
          { email: "busy@example.com", name: "Busy", declined: true },
          {
            email: "me@example.com",
            name: undefined,
            declined: false,
            self: true,
          },
          {
            email: "room@example.com",
            name: undefined,
            declined: false,
            resource: true,
          },
        ],
      }),
    );
  });

  it("finds the video link for an accepted invitation", async () => {
    calendarMocks.list.mockResolvedValue({
      data: {
        items: [
          {
            id: "invited-event-id",
            summary: "Customer call",
            description:
              "Join Zoom Meeting\nhttps://acme.zoom.us/j/8123456789?pwd=secret",
            organizer: { email: "host@example.com", self: false },
            start: { dateTime: "2026-05-04T09:00:00.000Z" },
            end: { dateTime: "2026-05-04T09:30:00.000Z" },
            attendees: [
              {
                email: "user@example.com",
                self: true,
                responseStatus: "accepted",
              },
            ],
          },
        ],
      },
    });

    const events = await createProvider().fetchEvents({
      timeMin: new Date("2026-05-04T00:00:00.000Z"),
      timeMax: new Date("2026-05-05T00:00:00.000Z"),
    });

    expect(events[0]).toEqual(
      expect.objectContaining({
        isOrganizer: false,
        videoConferenceLink: "https://acme.zoom.us/j/8123456789?pwd=secret",
      }),
    );
  });
});

describe("GoogleCalendarEventProvider calendars and dates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads every selected calendar, keeping an event shared between them once", async () => {
    const lecture = {
      id: "lecture",
      iCalUID: "lecture@ucsd",
      summary: "CSE 151B lecture",
      start: { dateTime: "2026-10-15T17:00:00Z" },
      end: { dateTime: "2026-10-15T18:20:00Z" },
    };
    calendarMocks.list.mockImplementation(async ({ calendarId }) => ({
      data: {
        items:
          calendarId === "student@ucsd.edu"
            ? [
                {
                  id: "office-hours",
                  summary: "Office hours",
                  start: { dateTime: "2026-10-15T20:00:00Z" },
                  end: { dateTime: "2026-10-15T21:00:00Z" },
                },
                lecture,
              ]
            : [lecture],
      },
    }));

    const events = await createProvider({
      calendarIds: ["student@ucsd.edu", "cse151b@group.calendar.google.com"],
    }).fetchEvents({
      timeMin: new Date("2026-10-15T00:00:00Z"),
      timeMax: new Date("2026-10-16T00:00:00Z"),
    });

    expect(
      calendarMocks.list.mock.calls.map(([params]) => params.calendarId),
    ).toEqual(["student@ucsd.edu", "cse151b@group.calendar.google.com"]);
    expect(events.map((event) => event.title)).toEqual([
      "CSE 151B lecture",
      "Office hours",
    ]);
  });

  it("marks a date-only event as all-day on its own date", async () => {
    calendarMocks.list.mockResolvedValue({
      data: {
        items: [
          {
            id: "hw3",
            summary: "HW 3 due",
            start: { date: "2026-10-20" },
            end: { date: "2026-10-21" },
          },
        ],
      },
    });

    const [event] = await createProvider().fetchEvents({
      timeMin: new Date("2026-10-20T00:00:00Z"),
    });

    expect(event).toMatchObject({
      allDay: true,
      startTime: new Date("2026-10-20T00:00:00Z"),
      endTime: new Date("2026-10-21T00:00:00Z"),
    });
  });
});

describe("GoogleCalendarEventProvider.createEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    calendarMocks.insert.mockResolvedValue({
      data: { id: "event-id", htmlLink: "https://calendar.google.com/e" },
    });
  });

  it("writes an all-day item as dates, not times", async () => {
    await createProvider().createEvent({
      allDay: true,
      attendees: [],
      calendarId: "primary",
      endTime: new Date("2026-10-21T00:00:00Z"),
      locationType: "CUSTOM",
      startTime: new Date("2026-10-20T00:00:00Z"),
      timezone: "America/Los_Angeles",
      title: "HW 3 due",
    });

    const { requestBody } = calendarMocks.insert.mock.calls[0][0];
    expect(requestBody.start).toEqual({ date: "2026-10-20" });
    expect(requestBody.end).toEqual({ date: "2026-10-21" });
  });
});

function createProvider({ calendarIds }: { calendarIds?: string[] } = {}) {
  return new GoogleCalendarEventProvider(
    {
      accessToken: "access-token",
      calendarIds,
      connectionId: "connection-id",
      emailAccountId: "email-account-id",
      expiresAt: null,
      refreshToken: "refresh-token",
    },
    createTestLogger(),
  );
}

function googleEvent(id: string, start: string) {
  return {
    id,
    summary: id,
    start: { dateTime: start },
    end: { dateTime: new Date(Date.parse(start) + 15 * 60_000).toISOString() },
  };
}
