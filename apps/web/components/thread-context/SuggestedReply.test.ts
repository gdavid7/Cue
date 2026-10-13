import { describe, expect, it, vi } from "vitest";
import { abstentionLine } from "@/components/thread-context/SuggestedReply";

vi.mock("@/utils/actions/thread-assist", () => ({
  saveSuggestedReplyAction: vi.fn(),
}));

describe("abstentionLine", () => {
  it("names a short missing fact", () => {
    expect(abstentionLine("Your flight's arrival time.")).toBe(
      "Cue couldn't confirm your flight's arrival time, so it left this for you.",
    );
  });

  it("names the first sentence when more follows", () => {
    expect(abstentionLine("The room number. No source says where it is.")).toBe(
      "Cue couldn't confirm the room number, so it left this for you.",
    );
  });

  it.each([
    ["", "nothing"],
    ["   ", "whitespace"],
    [
      "Whether you will be attending the event on Saturday or would prefer to join remotely",
      "a long sentence",
    ],
    ["Missing: the date (and time)", "list-like punctuation"],
    ["Do you want to go?", "a question"],
    ["time, place, and who is coming", "a list"],
  ])("leaves the reason out for %j (%s)", (missing) => {
    expect(abstentionLine(missing)).toBe("Cue left this reply to you.");
  });
});
