import { describe, expect, it } from "vitest";
import {
  looksLikeNaturalLanguage,
  widenSearchByTier,
} from "@/utils/mail-search/natural-language-search";

const NOW = new Date("2026-10-19T17:00:00Z");
const GOOGLE = { now: NOW, timeZone: "UTC", provider: "google" as const };
const DAY_S = 24 * 60 * 60;
const SEP_1 = Date.UTC(2026, 8, 1) / 1000;
const OCT_1 = Date.UTC(2026, 9, 1) / 1000;

describe("looksLikeNaturalLanguage", () => {
  it.each([
    "the lease contract Sarah sent last month",
    "invoices from last week",
    "when is my flight?",
    "flight times?",
    "¿cuándo sale mi vuelo",
    "le contrat de bail envoyé par Sarah",
    "上个月莎拉发的租赁合同",
    "先月サラが送った契約書",
    "emails from john@acme.com about the renewal",
  ])("reads %j as a sentence", (query) => {
    expect(looksLikeNaturalLanguage(query)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "invoice",
    "acme invoice",
    // A question needs two words.
    "what?",
    "flight?",
    "from:sarah lease",
    "lease OR contract with sarah",
    '"lease contract" from sarah',
    "-newsletter from my landlord",
    "(lease contract) sarah sent",
    "has:attachment the lease sarah sent",
    "https://example.com/a/b/c",
    "a".repeat(301),
  ])("leaves %j as a plain search", (query) => {
    expect(looksLikeNaturalLanguage(query)).toBe(false);
  });
});

describe("widenSearchByTier", () => {
  it("first leaves out each word group or condition in turn, keeping people and dates", () => {
    const tiers = widenSearchByTier(
      `from:tom (spreadsheet OR xlsx) has:attachment after:${SEP_1}`,
      GOOGLE,
    );
    expect(tiers.fewer_words).toEqual([
      `from:tom has:attachment after:${SEP_1}`,
      `from:tom (spreadsheet OR xlsx) after:${SEP_1}`,
    ]);
  });

  it("never leaves a search of only dates and conditions", () => {
    expect(
      widenSearchByTier(`lease has:attachment after:${SEP_1}`, GOOGLE)
        .fewer_words,
    ).toEqual([`lease after:${SEP_1}`]);
    expect(widenSearchByTier("lease", GOOGLE)).toEqual({
      fewer_words: [],
      sender_and_dates: [],
      wider_dates: [],
    });
  });

  it("then keeps only who the mail is with and when, a group of senders included", () => {
    expect(
      widenSearchByTier(
        `(from:sarah OR from:"Ana Lima") lease is:starred after:${SEP_1}`,
        GOOGLE,
      ).sender_and_dates,
    ).toEqual([`(from:sarah OR from:"Ana Lima") after:${SEP_1}`]);
    // Nothing to drop beside the sender: no tier repeats the search.
    expect(widenSearchByTier("from:sarah", GOOGLE).sender_and_dates).toEqual(
      [],
    );
  });

  it("then grows the window by its own length on each side, ending by now", () => {
    const month = OCT_1 - SEP_1;
    expect(
      widenSearchByTier(`from:sarah lease after:${SEP_1} before:${OCT_1}`, {
        ...GOOGLE,
        now: new Date("2027-03-01T00:00:00Z"),
      }).wider_dates,
    ).toEqual([
      `from:sarah lease after:${SEP_1 - month} before:${OCT_1 + month}`,
    ]);
    // A window reaching now stays open-ended; a short one grows a week.
    expect(
      widenSearchByTier(`lease after:${OCT_1 + 15 * DAY_S}`, GOOGLE)
        .wider_dates,
    ).toEqual([`lease after:${OCT_1 + 8 * DAY_S}`]);
    expect(widenSearchByTier("from:sarah lease", GOOGLE).wider_dates).toEqual(
      [],
    );
  });

  it("writes a wider Outlook window as received days in the account's zone", () => {
    expect(
      widenSearchByTier("from:sarah received>=2026-09-01 received<2026-10-01", {
        now: NOW,
        timeZone: "America/Los_Angeles",
        provider: "microsoft",
      }).wider_dates,
    ).toEqual(["from:sarah received>=2026-08-02"]);
  });
});
