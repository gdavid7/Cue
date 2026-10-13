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

function createProvider() {
  return new GoogleCalendarEventProvider(
    {
      accessToken: "access-token",
      connectionId: "connection-id",
      emailAccountId: "email-account-id",
      expiresAt: null,
      refreshToken: "refresh-token",
    },
    createTestLogger(),
  );
}
