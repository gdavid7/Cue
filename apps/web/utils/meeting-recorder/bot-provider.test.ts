import { describe, expect, it } from "vitest";
import { getMeetingBotDisplayName } from "@/utils/meeting-recorder/bot-provider";

describe("getMeetingBotDisplayName", () => {
  it("identifies the notetaker by the owner's first name", () => {
    expect(
      getMeetingBotDisplayName({
        ownerName: "Barbara Dalavecchia",
        ownerEmail: "barbara@example.com",
      }),
    ).toBe("Barbara's Cue Notetaker");
  });

  it("uses the owner's email when their profile has no name", () => {
    expect(
      getMeetingBotDisplayName({
        ownerName: null,
        ownerEmail: "barbara@example.com",
      }),
    ).toBe("barbara@example.com's Cue Notetaker");
  });

  it("stays within Recall's display-name limit", () => {
    const displayName = getMeetingBotDisplayName({
      ownerName: "B".repeat(101),
      ownerEmail: "barbara@example.com",
    });

    expect(displayName).toHaveLength(100);
    expect(displayName.endsWith("'s Cue Notetaker")).toBe(true);
  });

  it("does not split an astral Unicode character at the display-name limit", () => {
    const displayName = getMeetingBotDisplayName({
      ownerName: `${"B".repeat(83)}😀`,
      ownerEmail: "barbara@example.com",
    });

    expect(displayName).toBe(`${"B".repeat(83)}'s Cue Notetaker`);
    expect(displayName).toHaveLength(99);
  });
});
