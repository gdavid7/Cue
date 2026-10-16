import { describe, expect, it } from "vitest";
import { translateAccountSearch } from "./cross-provider-search";

const now = new Date("2026-10-16T12:00:00Z");

function gmailToOutlook(query: string) {
  return translateAccountSearch({
    search: { query },
    from: "google",
    to: "microsoft",
    now,
  });
}

function outlookToGmail(search: {
  query: string;
  fromEmail?: string;
  readState?: "read" | "unread";
}) {
  return translateAccountSearch({
    search,
    from: "microsoft",
    to: "google",
    now,
  });
}

describe("translateAccountSearch", () => {
  it("leaves a search for the same provider as it is", () => {
    const search = { query: "label:work is:starred renewal" };

    expect(
      translateAccountSearch({ search, from: "google", to: "google", now }),
    ).toEqual({ search, keywordsOnly: false });
  });

  describe("from Gmail to Outlook", () => {
    it("turns sender and read state into Outlook's structured filters", () => {
      expect(
        gmailToOutlook("from:dana@acme.example is:unread contract renewal"),
      ).toEqual({
        search: {
          query: "contract renewal",
          fromEmail: "dana@acme.example",
          readState: "unread",
        },
        keywordsOnly: false,
      });
    });

    it("keeps a single field as Outlook's own field", () => {
      expect(gmailToOutlook('subject:"contract renewal"')).toEqual({
        search: { query: 'subject:"contract renewal"' },
        keywordsOnly: false,
      });
      expect(gmailToOutlook("has:attachment")).toEqual({
        search: { query: "hasattachments:true" },
        keywordsOnly: false,
      });
    });

    it("turns Gmail dates into Outlook's received dates", () => {
      expect(gmailToOutlook("after:2026/01/15")).toEqual({
        search: { query: "received>=2026-01-15" },
        keywordsOnly: false,
      });
      expect(gmailToOutlook("newer_than:7d")).toEqual({
        search: { query: "received>=2026-10-09" },
        keywordsOnly: false,
      });
    });

    it("falls back to keywords for what Outlook can't combine or map", () => {
      expect(gmailToOutlook("label:work in:inbox renewal")).toEqual({
        search: { query: "renewal" },
        keywordsOnly: true,
      });
      expect(gmailToOutlook("subject:renewal after:2026/01/15 acme")).toEqual({
        search: { query: "acme renewal" },
        keywordsOnly: true,
      });
    });

    it("has nothing to search for when only mailbox scopes were asked", () => {
      expect(gmailToOutlook("in:inbox label:work")).toBeNull();
    });

    it("keeps a word with a colon that is no Gmail operator as a keyword", () => {
      expect(gmailToOutlook("https://acme.example/invoice")).toEqual({
        search: { query: "https://acme.example/invoice" },
        keywordsOnly: false,
      });
      expect(gmailToOutlook("standup 10:30")).toEqual({
        search: { query: "standup 10:30" },
        keywordsOnly: false,
      });
    });

    it("drops dates that don't exist and searches the keywords", () => {
      expect(gmailToOutlook("after:2024/13/45 invoice")).toEqual({
        search: { query: "invoice" },
        keywordsOnly: true,
      });
      expect(gmailToOutlook("before:2026/02/30 invoice")).toEqual({
        search: { query: "invoice" },
        keywordsOnly: true,
      });
      expect(gmailToOutlook("newer_than:99999999y invoice")).toEqual({
        search: { query: "invoice" },
        keywordsOnly: true,
      });
    });
  });

  describe("from Outlook to Gmail", () => {
    it("carries every filter Gmail can express", () => {
      expect(
        outlookToGmail({
          query: "renewal received>=2026-01-15 hasattachments:true",
          fromEmail: "dana@acme.example",
          readState: "unread",
        }),
      ).toEqual({
        search: {
          query:
            "from:dana@acme.example has:attachment is:unread after:2026/01/15 renewal",
        },
        keywordsOnly: false,
      });
    });

    it("reads Outlook's bare read-state word as a read state", () => {
      expect(outlookToGmail({ query: "unread invoice" })).toEqual({
        search: { query: "is:unread invoice" },
        keywordsOnly: false,
      });
    });

    it("falls back to keywords for Outlook fields Gmail has no match for", () => {
      expect(outlookToGmail({ query: "participants:dana renewal" })).toEqual({
        search: { query: "dana renewal" },
        keywordsOnly: true,
      });
    });

    it("keeps a word with a colon that is no Outlook field as a keyword", () => {
      expect(outlookToGmail({ query: "https://acme.example/invoice" })).toEqual(
        {
          search: { query: "https://acme.example/invoice" },
          keywordsOnly: false,
        },
      );
    });

    it("drops received dates that don't exist and searches the keywords", () => {
      expect(outlookToGmail({ query: "invoice received>=2024-13-45" })).toEqual(
        {
          search: { query: "invoice" },
          keywordsOnly: true,
        },
      );
    });
  });
});
