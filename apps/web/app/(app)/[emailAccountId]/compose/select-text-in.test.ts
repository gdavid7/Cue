// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { selectTextIn } from "./select-text-in";

afterEach(() => {
  document.body.innerHTML = "";
});

function editor(html: string) {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

describe("selectTextIn", () => {
  it("selects the first place the text appears", () => {
    const root = editor("<p>Hi {name},</p><p>Bye {name}</p>");
    expect(selectTextIn(root, "{name}")).toBe(true);
    const selection = window.getSelection();
    expect(selection?.toString()).toBe("{name}");
    expect(selection?.anchorNode).toBe(root.querySelector("p")?.firstChild);
  });

  it("returns false and leaves the selection when the text is not in one run", () => {
    const root = editor("<p>Hi <b>{na</b>me}</p>");
    window.getSelection()?.removeAllRanges();
    expect(selectTextIn(root, "{name}")).toBe(false);
    expect(window.getSelection()?.rangeCount).toBe(0);
  });
});
