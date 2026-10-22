import { describe, expect, it, vi } from "vitest";
import {
  buildSelfAddresses,
  isMeetingForUser,
  shouldLabelCalendars,
} from "@/utils/calendar/meeting-rules";

vi.mock("@/utils/prisma", () => ({ default: {} }));

const self = buildSelfAddresses({
  ownAddresses: ["me@personal.example", "Me@Work.example"],
  calendarAccounts: [{ email: "cal@other.example" }],
});

describe("isMeetingForUser", () => {
  it("keeps a meeting declined at the personal address but accepted at the work one", () => {
    expect(
      isMeetingForUser(
        {
          attendees: [
            { email: "me@personal.example", declined: true },
            { email: "me@work.example" },
          ],
        },
        self,
      ),
    ).toBe(true);
  });

  it("drops a meeting the user declined on every address they were invited at", () => {
    expect(
      isMeetingForUser(
        {
          attendees: [
            { email: "ME@personal.example", declined: true },
            { email: "me@work.example", declined: true },
            { email: "friend@example.com" },
          ],
        },
        self,
      ),
    ).toBe(false);
  });

  it("goes by the calendar's own entry where the provider marks it", () => {
    const attendees = [
      { email: "me@personal.example", declined: true, self: true },
      { email: "me@work.example" },
    ];

    expect(isMeetingForUser({ attendees }, self)).toBe(false);
  });

  it("counts the calendar account's own address as the user", () => {
    expect(
      isMeetingForUser(
        { attendees: [{ email: "cal@other.example", declined: true }] },
        self,
      ),
    ).toBe(false);
  });

  it("leaves out all-day entries, and keeps meetings without the user listed", () => {
    expect(isMeetingForUser({ allDay: true, attendees: [] }, self)).toBe(false);
    expect(
      isMeetingForUser(
        { attendees: [{ email: "friend@example.com", declined: true }] },
        self,
      ),
    ).toBe(true);
  });
});

describe("shouldLabelCalendars", () => {
  it("labels only with two connected calendar accounts", () => {
    const work = {
      id: "c1",
      provider: "google",
      email: "me@work.example",
      isConnected: true,
    };
    const home = { ...work, id: "c2", email: "me@personal.example" };

    expect(shouldLabelCalendars([work])).toBe(false);
    expect(shouldLabelCalendars([work, { ...home, isConnected: false }])).toBe(
      false,
    );
    expect(shouldLabelCalendars([work, home])).toBe(true);
  });
});
