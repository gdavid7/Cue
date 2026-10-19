import { describe, expect, it } from "vitest";
import {
  looksLikeNaturalLanguage,
  widenSearch,
} from "@/utils/mail-search/natural-language-search";

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

describe("widenSearch", () => {
  it("drops the dates, attachment and label first", () => {
    expect(
      widenSearch(
        "from:sarah has:attachment after:1756710000 before:1759302000 (lease OR contract)",
      ),
    ).toBe("from:sarah (lease OR contract)");
    expect(
      widenSearch("received>=2026-09-01 hasattachments:true from:sarah lease"),
    ).toBe("from:sarah lease");
  });

  it("turns a subject into words", () => {
    expect(widenSearch("subject:lease after:2026/09/01")).toBe("lease");
  });

  it("accepts any word when there is nothing to drop", () => {
    expect(widenSearch("lease contract")).toBe("lease OR contract");
    expect(widenSearch("lease (contract OR agreement)")).toBe(
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
