import { describe, expect, it } from "vitest";
import {
  formatTheirTime,
  getLatestSenderOffsets,
  getRecipientLocalTime,
} from "./recipient-local-time";

const ANA = "ana@example.com";
const DAY_MS = 24 * 60 * 60 * 1000;

function message(from: string, date: string, labelIds: string[] = ["INBOX"]) {
  return { headers: { from, date }, labelIds };
}

describe("getLatestSenderOffsets", () => {
  it("keeps each sender's latest message and when they sent it", () => {
    const offsets = getLatestSenderOffsets([
      message(`Ana <${ANA}>`, "Tue, 20 Oct 2026 10:00:00 +0100"),
      message(`Ana <${ANA.toUpperCase()}>`, "Sat, 24 Oct 2026 10:00:00 +0900"),
      message(`Ana <${ANA}>`, "Thu, 22 Oct 2026 10:00:00 -0500"),
    ]);
    expect(offsets[ANA]).toEqual({
      offsetMinutes: 540,
      sentAt: Date.UTC(2026, 9, 24, 1),
    });
  });

  it("does not fall back to an older offset when the latest message has none", () => {
    const offsets = getLatestSenderOffsets([
      message(ANA, "Tue, 20 Oct 2026 10:00:00 +0100"),
      message(ANA, "Sat, 24 Oct 2026 10:00:00 -0000"),
    ]);
    expect(offsets[ANA]?.offsetMinutes).toBeNull();
  });

  it("skips drafts and the user's own sent mail", () => {
    const offsets = getLatestSenderOffsets([
      message(ANA, "Tue, 20 Oct 2026 10:00:00 +0100"),
      message(ANA, "Sat, 24 Oct 2026 10:00:00 +0900", ["DRAFT"]),
      message(ANA, "Sat, 24 Oct 2026 11:00:00 +0900", ["SENT"]),
    ]);
    expect(offsets[ANA]?.offsetMinutes).toBe(60);
  });
});

describe("getRecipientLocalTime", () => {
  // 02:12 UTC is 03:12 at UTC+1, outside their day.
  const now = new Date(Date.UTC(2026, 9, 26, 2, 12));
  const sentAt = now.getTime() - DAY_MS;
  const pacific = () => -420;
  const base = {
    recipients: [ANA],
    senderOffsets: { [ANA]: { offsetMinutes: 60, sentAt } },
    ownOffsetAt: pacific,
    now,
  };
  const withOffset = (offsetMinutes: number | null) => ({
    ...base,
    senderOffsets: { [ANA]: { offsetMinutes, sentAt } },
  });

  it("gives their clock and, outside 8:00 to 20:00, offers their next 8:00", () => {
    const result = getRecipientLocalTime(base);
    expect(result).toMatchObject({
      offsetMinutes: 60,
      outsideDay: true,
      offerMorning: true,
    });
    expect(formatTheirTime(result!.now, 60, "en-US")).toBe("3:12 am");
    expect(result!.nextMorning.toISOString()).toBe("2026-10-26T07:00:00.000Z");
    expect(formatTheirTime(result!.nextMorning, 60, "en-US")).toBe("8:00 am");
  });

  it("moves their next 8:00 to tomorrow once their day has started", () => {
    // 21:30 UTC is 22:30 at UTC+1.
    const result = getRecipientLocalTime({
      ...base,
      now: new Date(Date.UTC(2026, 9, 26, 21, 30)),
    });
    expect(result?.outsideDay).toBe(true);
    expect(result?.nextMorning.toISOString()).toBe("2026-10-27T07:00:00.000Z");
  });

  it("treats 8:00 up to 19:59 their time as inside their day", () => {
    const at = (utcHour: number, minute = 0) =>
      getRecipientLocalTime({
        ...base,
        now: new Date(Date.UTC(2026, 9, 26, utcHour, minute)),
      })?.outsideDay;
    expect(at(6, 59)).toBe(true);
    expect(at(7)).toBe(false);
    expect(at(18, 59)).toBe(false);
    expect(at(19)).toBe(true);
  });

  it("offers no send time when their 8:00 is under ten minutes away", () => {
    const at = (minute: number) =>
      getRecipientLocalTime({
        ...base,
        now: new Date(Date.UTC(2026, 9, 26, 6, minute)),
      });
    // 07:50 their time: ten minutes to go is still worth scheduling.
    expect(at(50)).toMatchObject({ outsideDay: true, offerMorning: true });
    // 07:51 their time: too close.
    expect(at(51)).toMatchObject({ outsideDay: true, offerMorning: false });
  });

  it("does the math on fixed offsets, so a DST change on the user's side does not move their clock", () => {
    // 2026-03-08 and 2026-11-01 are US DST changes; the result only depends
    // on the instant and the sender's written offset.
    for (const at of [
      new Date(Date.UTC(2026, 2, 8, 9, 30)),
      new Date(Date.UTC(2026, 10, 1, 9, 30)),
    ]) {
      const result = getRecipientLocalTime({
        ...withOffset(330),
        senderOffsets: {
          [ANA]: { offsetMinutes: 330, sentAt: at.getTime() - DAY_MS },
        },
        now: at,
      });
      expect(formatTheirTime(result!.now, 330, "en-GB")).toBe("15:00");
    }
  });

  it("crosses the date line for far offsets", () => {
    // 20:00 UTC is 09:45 the next day at UTC+13:45.
    const result = getRecipientLocalTime({
      ...withOffset(825),
      now: new Date(Date.UTC(2026, 9, 26, 20, 0)),
    });
    expect(result?.outsideDay).toBe(false);
    expect(formatTheirTime(result!.now, 825, "en-GB")).toBe("9:45");
  });

  it("shows nothing for an unknown, UTC or same-as-yours offset", () => {
    for (const offset of [null, 0, -420]) {
      expect(getRecipientLocalTime(withOffset(offset))).toBeNull();
    }
    expect(getRecipientLocalTime({ ...base, senderOffsets: {} })).toBeNull();
  });

  it("shows nothing for someone in the user's zone who wrote before a DST change", () => {
    // Both in Berlin: they wrote at +0200 in summer; the user is at +0100 now.
    const berlin = (ms: number) => (ms < Date.UTC(2026, 9, 25, 1) ? 120 : 60);
    expect(
      getRecipientLocalTime({
        recipients: [ANA],
        senderOffsets: {
          [ANA]: { offsetMinutes: 120, sentAt: Date.UTC(2026, 9, 20, 9) },
        },
        ownOffsetAt: berlin,
        now,
      }),
    ).toBeNull();
  });

  it("ignores an offset from a message over a month old", () => {
    const stale = (ageDays: number) =>
      getRecipientLocalTime({
        ...base,
        senderOffsets: {
          [ANA]: {
            offsetMinutes: 60,
            sentAt: now.getTime() - ageDays * DAY_MS,
          },
        },
      });
    expect(stale(30)).not.toBeNull();
    expect(stale(31)).toBeNull();
  });

  it("shows nothing unless there is exactly one recipient", () => {
    expect(getRecipientLocalTime({ ...base, recipients: [] })).toBeNull();
    expect(
      getRecipientLocalTime({
        ...base,
        recipients: [ANA, "ben@example.com"],
        senderOffsets: {
          [ANA]: { offsetMinutes: 60, sentAt },
          "ben@example.com": { offsetMinutes: 60, sentAt },
        },
      }),
    ).toBeNull();
  });
});
