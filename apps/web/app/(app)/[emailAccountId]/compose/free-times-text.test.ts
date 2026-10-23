import { describe, expect, it } from "vitest";
import { formatFreeTimeSlot, formatFreeTimesHtml } from "./free-times-text";

describe("formatFreeTimeSlot", () => {
  it("names the zone's clock on each slot's own date across a DST change", () => {
    // New York falls back on Sunday, Nov 1 2026: 9:00 is 13:00Z before, 14:00Z after.
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-30T13:00:00Z", endTime: "2026-10-30T13:30:00Z" },
        "America/New_York",
      ),
    ).toBe("Fri, Oct 30, 9:00 – 9:30 AM EDT");
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-11-02T14:00:00Z", endTime: "2026-11-02T14:30:00Z" },
        "America/New_York",
      ),
    ).toBe("Mon, Nov 2, 9:00 – 9:30 AM EST");
  });

  it("keeps a London 9:00 at 9:00 when summer time ends", () => {
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-23T08:00:00Z", endTime: "2026-10-23T08:30:00Z" },
        "Europe/London",
      ),
    ).toBe("Fri, Oct 23, 9:00 – 9:30 AM GMT+1");
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-26T09:00:00Z", endTime: "2026-10-26T09:30:00Z" },
        "Europe/London",
      ),
    ).toBe("Mon, Oct 26, 9:00 – 9:30 AM GMT");
  });

  it("uses the account's date, not UTC's, in zones ahead of UTC", () => {
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-26T22:00:00Z", endTime: "2026-10-26T22:45:00Z" },
        "Asia/Tokyo",
      ),
    ).toBe("Tue, Oct 27, 7:00 – 7:45 AM GMT+9");
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-26T16:00:00Z", endTime: "2026-10-26T17:00:00Z" },
        "Asia/Kolkata",
      ),
    ).toBe("Mon, Oct 26, 9:30 – 10:30 PM GMT+5:30");
  });

  it("shows both dates for a slot that runs past midnight", () => {
    expect(
      formatFreeTimeSlot(
        { startTime: "2026-10-26T23:30:00Z", endTime: "2026-10-27T00:30:00Z" },
        "UTC",
      ),
    ).toBe("Mon, Oct 26, 11:30 PM UTC – Tue, Oct 27, 12:30 AM UTC");
  });

  it("uses plain spaces that every mail client can show", () => {
    const text = formatFreeTimeSlot(
      { startTime: "2026-10-30T13:00:00Z", endTime: "2026-10-30T13:30:00Z" },
      "America/Los_Angeles",
    );
    expect(text).not.toMatch(/[   ]/);
  });
});

describe("formatFreeTimesHtml", () => {
  const slots = [
    { startTime: "2026-10-30T13:00:00Z", endTime: "2026-10-30T13:30:00Z" },
    { startTime: "2026-11-02T14:00:00Z", endTime: "2026-11-02T14:30:00Z" },
  ];

  it("lists the times, then the booking link", () => {
    expect(
      formatFreeTimesHtml({
        slots,
        timezone: "America/New_York",
        bookingLink: "https://cal.example/me",
      }),
    ).toBe(
      "<p>Here are a few times that work for me:</p><ul><li>Fri, Oct 30, 9:00 – 9:30 AM EDT</li><li>Mon, Nov 2, 9:00 – 9:30 AM EST</li></ul>" +
        '<p>Or book a time here: <a href="https://cal.example/me">https://cal.example/me</a></p>',
    );
  });

  it("offers only the booking link when there are no times", () => {
    expect(
      formatFreeTimesHtml({
        slots: [],
        timezone: "UTC",
        bookingLink: "https://cal.example/me",
      }),
    ).toBe(
      '<p>You can book a time here: <a href="https://cal.example/me">https://cal.example/me</a></p>',
    );
  });

  it("returns nothing to insert when it has neither", () => {
    expect(
      formatFreeTimesHtml({ slots: [], timezone: "UTC", bookingLink: null }),
    ).toBeNull();
  });

  it("escapes the booking link", () => {
    const html = formatFreeTimesHtml({
      slots: [],
      timezone: "UTC",
      bookingLink: 'https://cal.example/"><img src=x>',
    });
    expect(html).not.toContain("<img");
  });
});
