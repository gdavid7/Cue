import { describe, expect, it } from "vitest";
import { looksLikeNotes, wordDiff } from "./compose-assist-text";

describe("wordDiff", () => {
  it("shows only the words a rewrite changed", () => {
    expect(
      wordDiff("can u send the doc pls", "could you send the doc please"),
    ).toEqual([
      { kind: "removed", text: "can u" },
      { kind: "added", text: "could you" },
      { kind: "same", text: " send the doc " },
      { kind: "removed", text: "pls" },
      { kind: "added", text: "please" },
    ]);
  });

  it("keeps both texts whole when read back", () => {
    const before = "Thanks so much for the update!\nTalk soon";
    const after = "Thanks for the quick update.\n\nTalk soon,";
    const parts = wordDiff(before, after);

    const read = (kind: "removed" | "added") =>
      parts
        .filter((part) => part.kind === "same" || part.kind === kind)
        .map((part) => part.text)
        .join("");
    expect(read("removed")).toBe(before);
    expect(read("added")).toBe(after);
  });

  it("treats a long passage as replaced instead of diffing every word", () => {
    const before = "word ".repeat(600);
    const after = "other ".repeat(600);

    expect(wordDiff(before, after)).toEqual([
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ]);
  });
});

describe("looksLikeNotes", () => {
  it("recognises bullets and fragments", () => {
    expect(
      looksLikeNotes("- budget approved\n- need deck by fri\n- lunch?"),
    ).toBe(true);
    expect(
      looksLikeNotes("budget approved\ndeck by friday\nlunch next week"),
    ).toBe(true);
  });

  it("leaves prose alone", () => {
    expect(
      looksLikeNotes(
        "Hi Sam,\nThanks for sending the budget over yesterday. It looks good to me.\nBest,",
      ),
    ).toBe(false);
    expect(looksLikeNotes("just one line")).toBe(false);
  });
});
