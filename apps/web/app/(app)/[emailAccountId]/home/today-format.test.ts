import { describe, expect, it } from "vitest";
import { formatSenders } from "./today-format";

describe("formatSenders", () => {
  it("names one, two or three senders in full", () => {
    expect(formatSenders(["Field Notes"])).toBe("Field Notes");
    expect(formatSenders(["Field Notes", "Morning Brew"])).toBe(
      "Field Notes and Morning Brew",
    );
    expect(formatSenders(["Field Notes", "Morning Brew", "Stratechery"])).toBe(
      "Field Notes, Morning Brew and Stratechery",
    );
  });

  it("names each sender once, in the order given, and counts the rest", () => {
    expect(
      formatSenders([
        "Field Notes",
        "Morning Brew",
        "Field Notes",
        "Stratechery",
        "The Atlantic",
        "Platformer",
      ]),
    ).toBe("Field Notes, Morning Brew, Stratechery and 2 more");
  });

  it("says nothing for no senders", () => {
    expect(formatSenders([])).toBe("");
    expect(formatSenders([" "])).toBe("");
  });
});
