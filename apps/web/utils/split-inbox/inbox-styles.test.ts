import { describe, expect, it } from "vitest";
import { createMailSplitBody } from "@/utils/actions/mail-split.validation";
import {
  getDefaultInboxStyle,
  getInboxStyleOptions,
  getInboxStyleSplits,
  INBOX_STYLES,
  orderSplitsForInboxStyle,
} from "@/utils/split-inbox/inbox-styles";
import { mailSplitToThreadsQuery } from "@/utils/split-inbox/split-query";

describe("inbox style choice", () => {
  it("preselects each provider's out-of-the-box inbox", () => {
    expect(getDefaultInboxStyle("google")).toBe("tabs");
    expect(getDefaultInboxStyle("microsoft")).toBe("focused-other");
  });

  it("offers only styles the provider can filter by", () => {
    expect(getInboxStyleOptions("google")).toEqual(["tabs", "one-inbox"]);
    expect(getInboxStyleOptions("microsoft")).toEqual([
      "focused-other",
      "one-inbox",
    ]);
    expect(getInboxStyleOptions("")).toEqual([]);
  });

  it("turns Gmail tabs into category splits, Primary first", () => {
    const splits = getInboxStyleSplits("tabs");

    expect(splits.map((split) => split.name)).toEqual([
      "Primary",
      "Promotions",
      "Social",
      "Updates",
    ]);
    expect(
      mailSplitToThreadsQuery({ matchAll: true, filters: splits[0].filters }),
    ).toEqual({ labelIds: ["INBOX", "CATEGORY_PERSONAL"] });
  });

  it("turns Focused and Other into Outlook inbox-section splits", () => {
    const splits = getInboxStyleSplits("focused-other");

    expect(
      splits.map((split) =>
        mailSplitToThreadsQuery({ matchAll: true, filters: split.filters }),
      ),
    ).toEqual([
      { type: "inbox", inboxSection: "focused" },
      { type: "inbox", inboxSection: "other" },
    ]);
  });

  it("adds no tabs for one inbox", () => {
    expect(getInboxStyleSplits("one-inbox")).toEqual([]);
  });

  it("only creates splits the split form itself would accept", () => {
    for (const style of INBOX_STYLES) {
      for (const split of getInboxStyleSplits(style)) {
        expect(
          createMailSplitBody.safeParse({ ...split, matchAll: true }).success,
        ).toBe(true);
      }
    }
  });
});

describe("orderSplitsForInboxStyle", () => {
  it("puts the style's tabs right after All and keeps the rest in order", () => {
    const splits = [
      { id: "all", filters: [] },
      { id: "unread", filters: [{}] },
      { id: "needs-reply", filters: [{}] },
      { id: "promotions", filters: [{}] },
      { id: "primary", filters: [{}] },
    ];

    expect(orderSplitsForInboxStyle(splits, ["primary", "promotions"])).toEqual(
      ["all", "primary", "promotions", "unread", "needs-reply"],
    );
  });
});
