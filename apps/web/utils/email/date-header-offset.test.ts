import { describe, expect, it } from "vitest";
import {
  formatDateWithUtcOffset,
  formatUtcOffset,
  parseDateHeaderOffsetMinutes,
} from "@/utils/email/date-header-offset";

describe("parseDateHeaderOffsetMinutes", () => {
  it("reads the numeric zone of an RFC 5322 Date header", () => {
    expect(
      parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 +0100"),
    ).toBe(60);
    expect(parseDateHeaderOffsetMinutes("26 Oct 2026 03:12 -0700")).toBe(-420);
    expect(
      parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 +0530 (IST)"),
    ).toBe(330);
    expect(
      parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 +1345"),
    ).toBe(825);
  });

  it("reads the offset of an ISO date", () => {
    expect(parseDateHeaderOffsetMinutes("2026-10-26T03:12:45+09:00")).toBe(540);
    expect(parseDateHeaderOffsetMinutes("2026-10-26T03:12:45.000-03:30")).toBe(
      -210,
    );
  });

  it("reads an explicit UTC zone as zero", () => {
    expect(
      parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 +0000"),
    ).toBe(0);
    expect(parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 GMT")).toBe(
      0,
    );
    expect(parseDateHeaderOffsetMinutes("2026-10-26T03:12:45.000Z")).toBe(0);
  });

  it("knows nothing from -0000, which RFC 5322 reserves for an unknown zone", () => {
    expect(
      parseDateHeaderOffsetMinutes("Mon, 26 Oct 2026 03:12:45 -0000"),
    ).toBeUndefined();
  });

  it("knows nothing from a missing, malformed or impossible zone", () => {
    for (const value of [
      undefined,
      null,
      "",
      "not a date",
      "Mon, 26 Oct 2026 03:12:45",
      "Mon, 26 Oct 2026 03:12:45 PST",
      "Mon, 26 Oct 2026 03:12:45 +0175",
      "Mon, 26 Oct 2026 03:12:45 +1500",
      "Mon, 26 Oct 2026 03:12:45 -1300",
      "Mon, 26 Oct 2026 03:12:45 +0107",
      "Mon, 99 Foo 2026 03:12:45 +0100",
    ]) {
      expect(parseDateHeaderOffsetMinutes(value)).toBeUndefined();
    }
  });
});

describe("formatDateWithUtcOffset", () => {
  it("writes the instant at the given offset, which reads back as the same instant and offset", () => {
    const ms = Date.UTC(2026, 9, 26, 2, 12, 45);
    const value = formatDateWithUtcOffset(ms, 60);
    expect(value).toBe("2026-10-26T03:12:45.000+01:00");
    expect(Date.parse(value)).toBe(ms);
    expect(parseDateHeaderOffsetMinutes(value)).toBe(60);
    expect(formatDateWithUtcOffset(ms, -210)).toBe(
      "2026-10-25T22:42:45.000-03:30",
    );
  });

  it("writes UTC when the offset is unknown", () => {
    const ms = Date.UTC(2026, 9, 26, 2, 12, 45);
    expect(formatDateWithUtcOffset(ms, undefined)).toBe(
      "2026-10-26T02:12:45.000Z",
    );
  });
});

describe("formatUtcOffset", () => {
  it("writes whole and part-hour offsets as people read them", () => {
    expect(formatUtcOffset(60)).toBe("UTC+1");
    expect(formatUtcOffset(330)).toBe("UTC+5:30");
    expect(formatUtcOffset(-210)).toBe("UTC-3:30");
    expect(formatUtcOffset(-600)).toBe("UTC-10");
  });
});
