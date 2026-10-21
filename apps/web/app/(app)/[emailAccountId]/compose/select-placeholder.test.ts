// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { selectPlaceholderIn } from "./select-placeholder";

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function editor(html: string) {
  const element = document.createElement("div");
  element.innerHTML = html;
  document.body.append(element);
  return element;
}

const selected = () => window.getSelection()?.toString();

describe("selectPlaceholderIn", () => {
  it("selects the first place the placeholder appears", () => {
    const root = editor("<p>Hi {name},</p><p>Bye {name}</p>");
    expect(selectPlaceholderIn(root, "{name}")).toBe(true);
    expect(selected()).toBe("{name}");
    expect(window.getSelection()?.anchorNode).toBe(
      root.querySelector("p")?.firstChild,
    );
  });

  it("returns false and leaves the selection when the text is not in one run", () => {
    const root = editor("<p>Hi <b>{na</b>me}</p>");
    expect(selectPlaceholderIn(root, "{name}")).toBe(false);
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it("skips code, quotes and links that come first", () => {
    const root = editor(
      "<p><code>{name}</code></p><pre>{name}</pre><blockquote>{name}</blockquote>" +
        '<div class="gmail_quote">{name}</div><a href="https://x.com">{name}</a>' +
        "<p>Hi {name}</p>",
    );
    expect(selectPlaceholderIn(root, "{name}")).toBe(true);
    expect(window.getSelection()?.anchorNode?.nodeValue).toBe("Hi {name}");
  });

  it("skips URLs, emails and longer tokens in the same text", () => {
    const root = editor(
      "<p>See https://x.com/[ID] or a@b.co/{name} or XXXX1234, then XXX</p>",
    );
    expect(selectPlaceholderIn(root, "XXX")).toBe(true);
    expect(selected()).toBe("XXX");
    expect(window.getSelection()?.anchorOffset).toBe(
      root.textContent?.lastIndexOf("XXX"),
    );
  });

  it("starts after an accent that was written as a separate mark", () => {
    const root = editor("<p>Jose\u0301{name}</p>");
    expect(selectPlaceholderIn(root, "{name}")).toBe(true);
    expect(selected()).toBe("{name}");
  });

  it("selects what the check flags when written with non-breaking spaces", () => {
    const root = editor("<p>Dear {{\u00a0first_name\u00a0}},</p>");
    expect(selectPlaceholderIn(root, "{{ first_name }}")).toBe(true);
    expect(selected()).toBe("{{\u00a0first_name\u00a0}}");
  });

  it("matches through non-breaking spaces and different Unicode forms", () => {
    const root = editor("<p>Café  [First Name] ok</p>");
    expect(selectPlaceholderIn(root, "[First Name]")).toBe(true);
    expect(selected()).toBe("[First Name]");
    const decomposed = editor("<p>Résumé [Name]</p>");
    expect(selectPlaceholderIn(decomposed, "[Name]")).toBe(true);
    expect(selected()).toBe("[Name]");
  });
});
