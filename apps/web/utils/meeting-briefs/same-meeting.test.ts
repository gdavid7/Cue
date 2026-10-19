import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { chooseBriefedCopy, isSameMeeting } from "./same-meeting";

describe("isSameMeeting", () => {
  it("matches one meeting's copies on two calendars", () => {
    expect(
      isSameMeeting(
        event({
          id: "a",
          attendees: ["Guest@Other.example", "me@work.example"],
        }),
        event({
          id: "b",
          attendees: ["guest@other.example", "me@home.example"],
        }),
      ),
    ).toBe(true);
  });

  it("keeps apart two meetings with the same title and time but different people", () => {
    expect(
      isSameMeeting(
        event({ id: "a", attendees: ["one@team.example"] }),
        event({ id: "b", attendees: ["two@team.example"] }),
      ),
    ).toBe(false);
  });

  it("keeps apart meetings that end at different times", () => {
    expect(
      isSameMeeting(
        event({ id: "a" }),
        event({ id: "b", endTime: new Date("2026-10-20T16:00:00.000Z") }),
      ),
    ).toBe(false);
  });

  it("matches on title and times when a copy lists no attendees", () => {
    expect(
      isSameMeeting(
        event({ id: "a", attendees: [] }),
        event({ id: "b", attendees: ["guest@other.example"] }),
      ),
    ).toBe(true);
  });
});

describe("chooseBriefedCopy", () => {
  it("chooses the same copy whichever mailbox asks", () => {
    const onA = event({ id: "event-a" });
    const onB = event({ id: "event-b" });
    const accounts = [
      { emailAccountId: "account-a", events: [onA] },
      { emailAccountId: "account-b", events: [onB] },
    ];

    expect(chooseBriefedCopy(onA, "account-a", accounts)).toEqual({
      emailAccountId: "account-a",
      eventId: "event-a",
    });
    expect(chooseBriefedCopy(onB, "account-b", accounts)).toEqual({
      emailAccountId: "account-a",
      eventId: "event-a",
    });
  });

  it("keeps a meeting found on one calendar only", () => {
    const onB = event({ id: "event-b" });
    expect(
      chooseBriefedCopy(onB, "account-b", [
        {
          emailAccountId: "account-a",
          events: [event({ id: "x", title: "Other" })],
        },
        { emailAccountId: "account-b", events: [onB] },
      ]),
    ).toEqual({ emailAccountId: "account-b", eventId: "event-b" });
  });
});

function event(
  overrides: Partial<Omit<CalendarEvent, "attendees">> & {
    attendees?: string[];
  } = {},
): CalendarEvent {
  const { attendees = ["guest@other.example"], ...rest } = overrides;
  return {
    id: "event",
    title: "Quarterly review",
    startTime: new Date("2026-10-20T15:00:00.000Z"),
    endTime: new Date("2026-10-20T15:30:00.000Z"),
    ...rest,
    attendees: attendees.map((email) => ({ email })),
  };
}
