import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { nextMeetingWith } from "./get-inbox-insights";

describe("nextMeetingWith", () => {
  it("picks the soonest meeting someone on the email is also invited to", () => {
    const meeting = nextMeetingWith(
      [{ email: "sarah@acme.com", name: "Sarah Chen" }],
      [
        event("later", "2026-10-20T17:00:00Z", ["sarah@acme.com"]),
        event("sooner", "2026-10-16T17:00:00Z", ["Sarah@Acme.com"]),
        event("unrelated", "2026-10-14T17:00:00Z", ["kevin@ucsd.edu"]),
      ],
    );

    expect(meeting).toMatchObject({ title: "sooner", with: "Sarah Chen" });
  });

  it("ignores meetings the person declined", () => {
    const declined = event("declined", "2026-10-16T17:00:00Z", []);
    declined.attendees = [{ email: "sarah@acme.com", declined: true }];

    expect(
      nextMeetingWith([{ email: "sarah@acme.com", name: "" }], [declined]),
    ).toBeNull();
  });
});

function event(title: string, start: string, emails: string[]): CalendarEvent {
  return {
    id: title,
    title,
    startTime: new Date(start),
    endTime: new Date(start),
    attendees: emails.map((email) => ({ email })),
  } as CalendarEvent;
}
