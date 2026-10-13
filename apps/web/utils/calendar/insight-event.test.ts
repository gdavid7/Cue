import { describe, expect, it } from "vitest";
import { getCalendarDraftFromInsight } from "@/utils/calendar/insight-event";
import type { EmailInsight } from "@/utils/inbox-insights/extract-insight";

describe("getCalendarDraftFromInsight", () => {
  it("makes a date-only deadline an all-day item titled by the task", () => {
    expect(
      getCalendarDraftFromInsight({
        insight: insight({
          task: "Submit HW 3",
          date: "2026-10-20",
          dateRole: "deadline",
        }),
        subject: "HW 3 reminder",
      }),
    ).toEqual({
      title: "Submit HW 3",
      allDay: true,
      start: "2026-10-20",
      end: null,
    });
  });

  it("makes a timed event a one-hour event at that moment", () => {
    expect(
      getCalendarDraftFromInsight({
        insight: insight({
          date: "2026-10-20T14:00-07:00",
          dateRole: "event",
        }),
        subject: "CSE 151B group meeting",
      }),
    ).toEqual({
      title: "CSE 151B group meeting",
      allDay: false,
      start: "2026-10-20T21:00:00.000Z",
      end: "2026-10-20T22:00:00.000Z",
    });
  });

  it("marks a timed deadline at its due time rather than as an hour-long meeting", () => {
    const draft = getCalendarDraftFromInsight({
      insight: insight({
        task: "Pay tuition",
        date: "2026-10-31T23:59Z",
        dateRole: "deadline",
      }),
      subject: "Tuition due",
    });

    expect(draft?.start).toBe("2026-10-31T23:59:00.000Z");
    expect(draft?.end).toBe("2026-11-01T00:29:00.000Z");
  });

  it("offers nothing for an expiry, a missing date, or no insight", () => {
    expect(
      getCalendarDraftFromInsight({
        insight: insight({ date: "2026-10-20", dateRole: "expires" }),
        subject: "Offer ends soon",
      }),
    ).toBeNull();
    expect(
      getCalendarDraftFromInsight({
        insight: insight({ date: null, dateRole: null }),
        subject: "Hello",
      }),
    ).toBeNull();
    expect(
      getCalendarDraftFromInsight({ insight: null, subject: "Hello" }),
    ).toBeNull();
  });
});

function insight(overrides: Partial<EmailInsight>): EmailInsight {
  return {
    action: "do",
    task: "",
    date: null,
    dateRole: null,
    fact: null,
    factLabel: null,
    ...overrides,
  };
}
