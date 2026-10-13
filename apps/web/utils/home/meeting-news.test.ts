import { describe, expect, it, vi } from "vitest";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { meetingOrganizations } from "./meeting-news";

vi.mock("server-only", () => ({}));

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
