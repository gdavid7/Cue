import { describe, expect, it } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import { summarizeBulkRun } from "./bulk-run-summary";

const rule = (
  name: string,
  types: ActionType[],
  enabled = true,
): Parameters<typeof summarizeBulkRun>[0][number] => ({
  name,
  enabled,
  actions: types.map((type) => ({ type })),
});

describe("summarizeBulkRun", () => {
  it("lists what the enabled rules do, once each", () => {
    const summary = summarizeBulkRun(
      [
        rule("Newsletters", [ActionType.LABEL, ActionType.ARCHIVE]),
        rule("Receipts", [ActionType.LABEL]),
        rule("Old", [ActionType.DELETE], false),
      ],
      { generateDraftReplies: false },
    );

    expect(summary).toEqual({
      ruleCount: 2,
      actions: ["Label", "Archive"],
      sendingRules: [],
      deletes: false,
    });
  });

  it("names the rules that send mail on the user's behalf", () => {
    const summary = summarizeBulkRun(
      [
        rule("Forward invoices", [ActionType.FORWARD]),
        rule("Auto reply", [ActionType.REPLY]),
        rule("Labels", [ActionType.LABEL]),
      ],
      { generateDraftReplies: false },
    );

    expect(summary.sendingRules).toEqual(["Forward invoices", "Auto reply"]);
  });

  it("only counts drafts when the run will write them", () => {
    const rules = [rule("To Reply", [ActionType.DRAFT_EMAIL])];

    expect(
      summarizeBulkRun(rules, { generateDraftReplies: false }).actions,
    ).toEqual([]);
    expect(
      summarizeBulkRun(rules, { generateDraftReplies: true }).actions,
    ).toEqual(["Draft reply"]);
  });

  it("flags deleting rules", () => {
    expect(
      summarizeBulkRun([rule("Spam", [ActionType.DELETE])], {
        generateDraftReplies: false,
      }).deletes,
    ).toBe(true);
  });
});
