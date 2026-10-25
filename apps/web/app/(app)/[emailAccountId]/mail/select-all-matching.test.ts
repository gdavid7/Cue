import { getMatchingResultCopy } from "@/components/mail-bulk/follow-matching-jobs";
import { describe, expect, it } from "vitest";
import {
  getMatchingBannerCopy,
  getMatchingScope,
  needsMatchingConfirm,
  getAccountMatchingScope,
} from "@/app/(app)/[emailAccountId]/mail/select-all-matching";
import { inboxWithoutReadingQuery } from "@/app/(app)/[emailAccountId]/mail/reading-lane";

describe("getMatchingScope", () => {
  it("describes plain views and searches", () => {
    expect(getMatchingScope({ type: "inbox" }, "google")).toEqual({
      type: "inbox",
    });
    expect(getMatchingScope({ q: "invoice" }, "microsoft")).toEqual({
      q: "invoice",
    });
    expect(getMatchingScope({ labelId: "Label_1" }, "google")).toEqual({
      labelId: "Label_1",
    });
    expect(getMatchingScope({ folderId: "AAMk" }, "microsoft")).toEqual({
      folderId: "AAMk",
    });
    expect(
      getMatchingScope({ type: "inbox", isUnread: true }, "google"),
    ).toEqual({ type: "inbox", isUnread: true });
  });

  it("leaves out views a provider query can't reproduce", () => {
    expect(
      getMatchingScope(
        { type: "inbox", anyOf: [{ fromEmail: "a@example.com" }] },
        "google",
      ),
    ).toBeNull();
    expect(
      getMatchingScope({ type: "inbox", cue: ["to_reply"] }, "google"),
    ).toBeNull();
    expect(
      getMatchingScope({ type: "inbox", inboxSection: "focused" }, "microsoft"),
    ).toBeNull();
    // Outlook categories aren't listable in bulk.
    expect(getMatchingScope({ labelId: "Blue" }, "microsoft")).toBeNull();
    expect(getMatchingScope({ type: "snoozed" }, "google")).toBeNull();
  });
});

describe("getMatchingBannerCopy", () => {
  it("offers every conversation in the view, with its count when known", () => {
    expect(
      getMatchingBannerCopy({
        pageCount: 50,
        total: 1234,
        viewTitle: "Inbox",
        isSearch: false,
        active: false,
      }),
    ).toEqual({
      message: "All 50 conversations on this page are selected.",
      action: "Select all 1,234 conversations in Inbox",
    });
    expect(
      getMatchingBannerCopy({
        pageCount: 50,
        total: null,
        viewTitle: "Search results",
        isSearch: true,
        active: false,
      }).action,
    ).toBe("Select all conversations that match this search");
  });

  it("says what is selected once every conversation is", () => {
    expect(
      getMatchingBannerCopy({
        pageCount: 50,
        total: 1234,
        viewTitle: "Inbox",
        isSearch: false,
        active: true,
      }),
    ).toEqual({
      message: "All 1,234 conversations in Inbox are selected.",
      action: "Clear selection",
    });
    expect(
      getMatchingBannerCopy({
        pageCount: 50,
        total: null,
        viewTitle: "Search results",
        isSearch: true,
        active: true,
      }).message,
    ).toBe("All conversations that match this search are selected.");
  });
});

describe("needsMatchingConfirm", () => {
  it("confirms destructive actions over the threshold or of unknown size", () => {
    expect(needsMatchingConfirm("trash", 20)).toBe(false);
    expect(needsMatchingConfirm("trash", 500)).toBe(true);
    expect(needsMatchingConfirm("spam", null)).toBe(true);
    expect(needsMatchingConfirm("archive", 50_000)).toBe(false);
  });

  it("always confirms deleting forever", () => {
    expect(needsMatchingConfirm("delete_forever", 1)).toBe(true);
  });
});

describe("getMatchingResultCopy", () => {
  it("names how many conversations changed", () => {
    expect(getMatchingResultCopy("archive", 1)).toBe("Archived 1 conversation");
    expect(getMatchingResultCopy("mark_read", 1234)).toBe(
      "Marked 1,234 conversations as read",
    );
    expect(getMatchingResultCopy("delete_forever", 3)).toBe(
      "Deleted 3 conversations forever",
    );
  });
});

describe("getAccountMatchingScope", () => {
  it("never covers a bundled inbox, whose newsletters the user never saw selected", () => {
    const query = { type: "inbox" };
    expect(
      getAccountMatchingScope({
        query,
        provider: "google",
        bundlesReading: true,
      }),
    ).toBeNull();
    expect(
      getAccountMatchingScope({
        query,
        provider: "google",
        bundlesReading: false,
      }),
    ).toEqual({ type: "inbox" });
  });

  it("stays per page in an inbox bundled by Cue's sorting alone", () => {
    const query = inboxWithoutReadingQuery({ labelId: undefined, byCue: true });
    if (!query) throw new Error("expected a bundled inbox");
    expect(
      getAccountMatchingScope({
        query,
        provider: "google",
        bundlesReading: true,
      }),
    ).toBeNull();
    // Nor could the list's own query be listed in full.
    expect(getMatchingScope(query, "google")).toBeNull();
  });
});
