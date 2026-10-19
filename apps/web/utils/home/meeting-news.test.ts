import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { searchExa } from "@/utils/exa/search";
import { getMeetingNews, meetingOrganizations } from "./meeting-news";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(),
}));
vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => true,
  searchExa: vi.fn(),
}));

const ME = "david@brightline.io";

function event(
  id: string,
  startTime: string,
  attendees: CalendarEvent["attendees"],
  self = ME,
): CalendarEvent {
  return {
    id,
    title: id,
    startTime: new Date(startTime),
    endTime: new Date(startTime),
    attendees: [{ email: self }, ...attendees],
  };
}

describe("meetingOrganizations", () => {
  it("finds the outside organization, ignoring colleagues, personal mail and automated senders", () => {
    const meetings = meetingOrganizations(
      [
        event("renewal", "2026-10-14T17:00:00Z", [
          { email: "priya@brightline.io" },
          { email: "sarah@acmecorp.com" },
          { email: "Ben@AcmeCorp.com" },
          { email: "linda.lin@gmail.com" },
          { email: "calendar-notification@zoom.us" },
          { email: "maya@waymo.com" },
        ]),
      ],
      ME,
    );

    expect(meetings.map((m) => [m.event.id, m.organization])).toEqual([
      ["renewal", "acmecorp.com"],
    ]);
  });

  it("skips meetings with only colleagues, personal addresses or declined guests", () => {
    expect(
      meetingOrganizations(
        [
          event("standup", "2026-10-14T16:00:00Z", [
            { email: "marcus@brightline.io" },
          ]),
          event("family", "2026-10-14T18:00:00Z", [
            { email: "linda.lin@gmail.com" },
            { email: "dad@icloud.com" },
          ]),
          event("declined", "2026-10-14T19:00:00Z", [
            { email: "sarah@acmecorp.com", declined: true },
          ]),
        ],
        ME,
      ),
    ).toEqual([]);
  });

  it("shows an organization once, for its first meeting", () => {
    const meetings = meetingOrganizations(
      [
        event("second", "2026-10-15T17:00:00Z", [
          { email: "sarah@acmecorp.com" },
        ]),
        event("first", "2026-10-14T17:00:00Z", [
          { email: "sarah@acmecorp.com" },
        ]),
      ],
      ME,
    );

    expect(meetings.map((m) => m.event.id)).toEqual(["first"]);
  });

  it("treats every company as outside for someone on personal mail", () => {
    const meetings = meetingOrganizations(
      [
        event(
          "interview",
          "2026-10-14T17:00:00Z",
          [{ email: "jessica.park@nvidia.com" }],
          "david.lin@gmail.com",
        ),
      ],
      "david.lin@gmail.com",
    );

    expect(meetings.map((m) => m.organization)).toEqual(["nvidia.com"]);
  });
});

describe("getMeetingNews", () => {
  // RD-3: who the user meets is personal, so the shared cache of public
  // headlines is keyed by a hash of the organization, never its name.
  it("caches public headlines under a hash of the organization", async () => {
    recordingRedis.reset();
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      events: [
        event("renewal", "2026-10-14T17:00:00Z", [
          { email: "sarah@acmecorp.com" },
        ]),
      ],
      complete: true,
    } as never);
    vi.mocked(searchExa).mockResolvedValue([
      { title: "Acme raises prices", url: "https://news.example/acme" },
    ] as never);

    const first = await getMeetingNews({
      emailAccountId: "account-1",
      userEmail: ME,
      logger: createTestLogger(),
      now: new Date("2026-10-13T16:00:00Z"),
    });
    await getMeetingNews({
      emailAccountId: "account-1",
      userEmail: ME,
      logger: createTestLogger(),
      now: new Date("2026-10-13T16:00:00Z"),
    });

    expect(first[0]?.news[0]?.title).toBe("Acme raises prices");
    expect(searchExa).toHaveBeenCalledTimes(1);
    const keys = recordingRedis.writes.map((write) => write.key);
    expect(keys).toEqual([
      expect.stringMatching(/^meeting-news:[0-9a-f]{64}$/),
    ]);
    expect(keys.join()).not.toContain("acmecorp");
  });
});
