import { describe, expect, it } from "vitest";
import {
  getInvitationWindow,
  isCovered,
  isInvitationCopy,
  rangesOverlap,
} from "@/utils/calendar/conflicts";

const range = (start: string, end: string) => ({
  start: new Date(start),
  end: new Date(end),
});

describe("rangesOverlap", () => {
  const meeting = range("2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z");

  it("treats any shared time as overlap", () => {
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T10:30:00Z", "2030-03-04T11:30:00Z"),
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T09:00:00Z", "2030-03-04T12:00:00Z"),
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T10:15:00Z", "2030-03-04T10:45:00Z"),
      ),
    ).toBe(true);
  });

  it("does not treat back-to-back meetings as overlapping", () => {
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T11:00:00Z", "2030-03-04T12:00:00Z"),
      ),
    ).toBe(false);
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T09:00:00Z", "2030-03-04T10:00:00Z"),
      ),
    ).toBe(false);
  });

  it("compares instants, whatever zone each side is written in", () => {
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T05:30:00-05:00", "2030-03-04T06:30:00-05:00"),
      ),
    ).toBe(true);
    expect(
      rangesOverlap(
        meeting,
        range("2030-03-04T12:00:00+01:00", "2030-03-04T13:00:00+01:00"),
      ),
    ).toBe(false);
  });
});

describe("isCovered", () => {
  const busy = range("2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z");

  it("is covered by one event or by several that leave no gap", () => {
    expect(
      isCovered(busy, [range("2030-03-04T09:00:00Z", "2030-03-04T12:00:00Z")]),
    ).toBe(true);
    expect(
      isCovered(busy, [
        range("2030-03-04T10:30:00Z", "2030-03-04T11:00:00Z"),
        range("2030-03-04T10:00:00Z", "2030-03-04T10:30:00Z"),
      ]),
    ).toBe(true);
  });

  it("is not covered when any moment is left over", () => {
    expect(isCovered(busy, [])).toBe(false);
    expect(
      isCovered(busy, [
        range("2030-03-04T10:00:00Z", "2030-03-04T10:20:00Z"),
        range("2030-03-04T10:30:00Z", "2030-03-04T11:00:00Z"),
      ]),
    ).toBe(false);
    expect(
      isCovered(busy, [range("2030-03-04T10:00:00Z", "2030-03-04T10:59:00Z")]),
    ).toBe(false);
  });
});

describe("getInvitationWindow", () => {
  const now = new Date("2030-03-01T00:00:00Z");

  it("reads a timed invitation as its instants", () => {
    expect(
      getInvitationWindow(
        {
          start: "2030-03-04T10:00:00.000Z",
          end: "2030-03-04T11:00:00.000Z",
          allDay: false,
        },
        now,
      ),
    ).toEqual(range("2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"));
  });

  it("skips all-day invitations, ones without an end, and ones already over", () => {
    expect(
      getInvitationWindow(
        { start: "2030-03-04", end: "2030-03-05", allDay: true },
        now,
      ),
    ).toBeNull();
    expect(
      getInvitationWindow(
        { start: "2030-03-04T10:00:00.000Z", end: null, allDay: false },
        now,
      ),
    ).toBeNull();
    expect(
      getInvitationWindow(
        {
          start: "2030-02-01T10:00:00.000Z",
          end: "2030-02-01T11:00:00.000Z",
          allDay: false,
        },
        now,
      ),
    ).toBeNull();
  });

  it("still checks a meeting that is under way", () => {
    expect(
      getInvitationWindow(
        {
          start: "2030-02-28T23:30:00.000Z",
          end: "2030-03-01T00:30:00.000Z",
          allDay: false,
        },
        now,
      ),
    ).not.toBeNull();
  });

  it("skips windows longer than a day", () => {
    expect(
      getInvitationWindow(
        {
          start: "2030-03-04T10:00:00.000Z",
          end: "2030-03-05T10:00:01.000Z",
          allDay: false,
        },
        now,
      ),
    ).toBeNull();
  });
});

describe("isInvitationCopy", () => {
  const invitation = {
    title: "Project planning",
    organizer: "organizer@example.com",
    ...range("2030-03-04T10:00:00Z", "2030-03-04T11:00:00Z"),
  };

  it("matches an event with the same title and the same instants", () => {
    expect(
      isInvitationCopy(
        {
          title: "Project planning",
          start: "2030-03-04T11:00:00+01:00",
          end: "2030-03-04T12:00:00+01:00",
        },
        invitation,
      ),
    ).toBe(true);
  });

  it("matches the event with the invitation's UID only when the organizer matches too", () => {
    const sameUid = {
      title: "Something else",
      start: "2030-03-04T10:00:00Z",
      end: "2030-03-04T11:00:00Z",
    };
    expect(
      isInvitationCopy(
        { ...sameUid, uidMatch: { organizer: "organizer@example.com" } },
        invitation,
      ),
    ).toBe(true);
    // A sender who reuses another meeting's UID can't hide that meeting.
    expect(
      isInvitationCopy(
        { ...sameUid, uidMatch: { organizer: "someone@else.example" } },
        invitation,
      ),
    ).toBe(false);
    expect(
      isInvitationCopy(
        { ...sameUid, uidMatch: { organizer: null } },
        invitation,
      ),
    ).toBe(false);
  });

  it("never matches an untitled event", () => {
    expect(
      isInvitationCopy(
        {
          title: null,
          start: "2030-03-04T10:00:00Z",
          end: "2030-03-04T11:00:00Z",
        },
        invitation,
      ),
    ).toBe(false);
  });

  it("keeps a different meeting at the same time", () => {
    expect(
      isInvitationCopy(
        {
          title: "Dentist",
          start: "2030-03-04T10:00:00Z",
          end: "2030-03-04T11:00:00Z",
        },
        invitation,
      ),
    ).toBe(false);
    expect(
      isInvitationCopy(
        {
          title: "Project planning",
          start: "2030-03-04T10:00:00Z",
          end: "2030-03-04T10:30:00Z",
        },
        invitation,
      ),
    ).toBe(false);
  });
});
