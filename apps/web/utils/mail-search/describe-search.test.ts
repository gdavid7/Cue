import { describe, expect, it } from "vitest";
import { describeSearch } from "@/utils/mail-search/describe-search";

describe("describeSearch", () => {
  it("writes Gmail's epoch dates as days in the account's time zone", () => {
    // 2026-10-03 00:00 in Los Angeles.
    const search = "from:sarah after:1791010800 before:1791097200 lease";

    expect(
      describeSearch(search, {
        timeZone: "America/Los_Angeles",
        locale: "en-US",
      }),
    ).toBe("from:sarah after Oct 3, 2026 before Oct 4, 2026 lease");
  });

  it("follows the locale's date order", () => {
    expect(
      describeSearch("after:1791010800", {
        timeZone: "America/Los_Angeles",
        locale: "de-DE",
      }),
    ).toBe("after 03.10.2026");
  });

  it("writes Outlook's whole days without shifting them by zone", () => {
    expect(
      describeSearch("from:sarah received>=2026-10-03 received<2026-10-05", {
        timeZone: "Pacific/Auckland",
        locale: "en-US",
      }),
    ).toBe("from:sarah from Oct 3, 2026 before Oct 5, 2026");
  });

  it("leaves words that only look like dates alone", () => {
    expect(
      describeSearch("lease after:2026/10/03 order 1791010800", {
        timeZone: "UTC",
        locale: "en-US",
      }),
    ).toBe("lease after:2026/10/03 order 1791010800");
  });
});
