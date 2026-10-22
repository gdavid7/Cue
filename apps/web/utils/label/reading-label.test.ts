import { describe, expect, it } from "vitest";
import { findReadingLabelId } from "./reading-label";

describe("findReadingLabelId", () => {
  it("finds the label Cue files newsletters under, as named in the mailbox", () => {
    expect(
      findReadingLabelId([
        { id: "Label_1", name: "Receipt" },
        { id: "Label_42", name: " newsletter " },
      ]),
    ).toBe("Label_42");
  });

  it("is undefined when the account has no such label", () => {
    expect(findReadingLabelId([{ id: "Label_1", name: "Receipt" }])).toBe(
      undefined,
    );
  });
});
