import { describe, expect, it } from "vitest";
import type { MailboxLabelCount } from "@/utils/mail-engine/label-count-targets";
import {
  getSystemRuleLabelIds,
  splitLabelsByListVisibility,
} from "./label-visibility";

function counts(entries: Array<{ id: string; unread: number }>) {
  return new Map<string, MailboxLabelCount>(
    entries.map(({ id, unread }) => [
      id,
      { id, name: id, kind: "label", total: unread, unread },
    ]),
  );
}

describe("splitLabelsByListVisibility", () => {
  it("moves hidden labels out of the main list", () => {
    const { visibleLabels, hiddenLabels } = splitLabelsByListVisibility({
      labels: [
        { id: "receipts", name: "Receipts", labelListVisibility: "labelHide" },
        { id: "calendar", name: "Calendar", labelListVisibility: "labelShow" },
        { id: "travel", name: "Travel" },
      ],
      countsById: counts([]),
    });

    expect(visibleLabels.map((label) => label.id)).toEqual([
      "calendar",
      "travel",
    ]);
    expect(hiddenLabels.map((label) => label.id)).toEqual(["receipts"]);
  });

  it("hides a show-if-unread label once it has no unread mail", () => {
    const { visibleLabels, hiddenLabels } = splitLabelsByListVisibility({
      labels: [
        {
          id: "receipts",
          name: "Receipts",
          labelListVisibility: "labelShowIfUnread",
        },
        {
          id: "travel",
          name: "Travel",
          labelListVisibility: "labelShowIfUnread",
        },
      ],
      countsById: counts([
        { id: "receipts", unread: 0 },
        { id: "travel", unread: 3 },
      ]),
    });

    expect(visibleLabels.map((label) => label.id)).toEqual(["travel"]);
    expect(hiddenLabels.map((label) => label.id)).toEqual(["receipts"]);
  });

  it("keeps a show-if-unread label while its count is unknown", () => {
    const { visibleLabels } = splitLabelsByListVisibility({
      labels: [
        {
          id: "receipts",
          name: "Receipts",
          labelListVisibility: "labelShowIfUnread",
        },
      ],
      countsById: counts([]),
    });

    expect(visibleLabels.map((label) => label.id)).toEqual(["receipts"]);
  });
});

describe("getSystemRuleLabelIds", () => {
  it("collects the labels Cue's built-in rules apply, whatever they are named", () => {
    const ids = getSystemRuleLabelIds([
      {
        systemType: "TO_REPLY",
        actions: [{ labelId: "Label_1" }, { labelId: null }],
      },
      { systemType: "NEWSLETTER", actions: [{ labelId: "Label_2" }] },
      { systemType: "FYI", actions: [] },
    ]);

    expect([...ids]).toEqual(["Label_1", "Label_2"]);
  });

  it("keeps labels from rules the user wrote", () => {
    const ids = getSystemRuleLabelIds([
      { systemType: null, actions: [{ labelId: "Label_clients" }] },
      { systemType: "TO_REPLY", actions: [{ labelId: "Label_to_reply" }] },
    ]);

    expect(ids.has("Label_clients")).toBe(false);
    expect(ids.has("Label_to_reply")).toBe(true);
  });
});
