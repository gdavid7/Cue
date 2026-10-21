import { describe, expect, it } from "vitest";
import { findEscapedMarkup } from "./suggestion-text";

describe("findEscapedMarkup", () => {
  it("accepts plain punctuation", () => {
    expect(
      findEscapedMarkup(`I'm sending Q3's numbers & notes. "Soon" <3 -> 5 > 4`),
    ).toEqual([]);
  });

  it.each([
    ["I&#x27;m on it", "&#"],
    ["Q3 &amp; Q4", "&amp;"],
    ["a &lt; b", "&lt;"],
    ["a &gt; b", "&gt;"],
    ["he said &quot;yes&quot;", "&quot;"],
    ["<p>Sure</p>", "<p>"],
    ["Thanks<br>Jo", "<br>"],
    ["Thanks<br/>Jo", "<br>"],
  ])("flags %s", (text, kind) => {
    expect(findEscapedMarkup(text)).toContain(kind);
  });
});
