import { describe, expect, it } from "vitest";
import {
  cleanGeneratedSearch,
  looksLikeNaturalLanguage,
  widenSearch,
} from "@/utils/mail-search/natural-language-search";

const NOW = new Date("2026-10-19T16:00:00Z");
const GMAIL = { now: NOW, provider: "google" as const, labelNames: [] };
const OUTLOOK = { now: NOW, provider: "microsoft" as const, labelNames: [] };

describe("looksLikeNaturalLanguage", () => {
  it.each([
    "the lease contract Sarah sent last month",
    "invoices from last week",
    "when is my flight?",
    "flight?",
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

describe("cleanGeneratedSearch", () => {
  it("keeps a well-formed search in Gmail's syntax", () => {
    expect(
      cleanGeneratedSearch(
        "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
        GMAIL,
      ),
    ).toBe(
      "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
    );
  });

  it("writes dates and attachments in Outlook's syntax for an Outlook account", () => {
    expect(
      cleanGeneratedSearch(
        "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease",
        OUTLOOK,
      ),
    ).toBe(
      "from:sarah hasattachments:true received>=2026-09-01 received<2026-10-01 lease",
    );
  });

  it("resolves relative ages to dates", () => {
    expect(cleanGeneratedSearch("newer_than:7d invoice", GMAIL)).toBe(
      "after:2026/10/12 invoice",
    );
  });

  it("drops operators Cue doesn't run, and unknown labels", () => {
    expect(
      cleanGeneratedSearch(
        "in:trash larger:5M filename:pdf label:made-up is:muted lease",
        GMAIL,
      ),
    ).toBe("lease");
  });

  it("keeps a label the account has, under its real name", () => {
    expect(
      cleanGeneratedSearch("label:receipts amazon", {
        ...GMAIL,
        labelNames: ["Receipts"],
      }),
    ).toBe("label:Receipts amazon");
    expect(
      cleanGeneratedSearch("label:receipts amazon", {
        ...OUTLOOK,
        labelNames: ["Receipts"],
      }),
    ).toBe("category:Receipts amazon");
  });

  it("drops invalid and impossible dates", () => {
    expect(cleanGeneratedSearch("after:2026/02/30 lease", GMAIL)).toBe("lease");
    expect(cleanGeneratedSearch("after:last-month lease", GMAIL)).toBe("lease");
    // Mail from the future.
    expect(cleanGeneratedSearch("after:2027/01/01 lease", GMAIL)).toBe("lease");
    // A range with no day in it.
    expect(
      cleanGeneratedSearch("after:2026/09/10 before:2026/09/01 lease", GMAIL),
    ).toBe("lease");
  });

  it("quotes values with spaces", () => {
    expect(cleanGeneratedSearch('from:"Sarah Lee" lease', GMAIL)).toBe(
      'from:"Sarah Lee" lease',
    );
  });

  it("returns null when nothing searchable is left", () => {
    expect(cleanGeneratedSearch("", GMAIL)).toBeNull();
    expect(cleanGeneratedSearch("in:trash larger:5M", GMAIL)).toBeNull();
    expect(cleanGeneratedSearch("-newsletter", GMAIL)).toBeNull();
  });

  it("only negates single words and people", () => {
    expect(cleanGeneratedSearch("lease -from:zillow -is:unread", GMAIL)).toBe(
      "lease -from:zillow",
    );
  });
});

describe("widenSearch", () => {
  it("drops the dates, attachment and label first", () => {
    expect(
      widenSearch(
        "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract",
      ),
    ).toBe("from:sarah lease OR contract");
    expect(
      widenSearch("received>=2026-09-01 hasattachments:true from:sarah lease"),
    ).toBe("from:sarah lease");
  });

  it("turns a subject into words", () => {
    expect(widenSearch("subject:lease after:2026/09/01")).toBe("lease");
  });

  it("accepts any word when there is nothing to drop", () => {
    expect(widenSearch("lease contract")).toBe("lease OR contract");
    expect(widenSearch("lease contract OR agreement")).toBe(
      "lease OR contract OR agreement",
    );
  });

  it("keeps just the person when there are words beside them", () => {
    expect(widenSearch("from:sarah lease")).toBe("from:sarah");
  });

  it("returns null when a search can't get wider", () => {
    expect(widenSearch("lease")).toBeNull();
    expect(widenSearch("from:sarah")).toBeNull();
    expect(widenSearch("lease OR contract")).toBeNull();
  });
});
