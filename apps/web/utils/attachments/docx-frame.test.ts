// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { renderAsync } from "docx-preview";
import { describe, expect, it, vi } from "vitest";
import {
  createFrameElementFactory,
  DOCX_RENDER_OPTIONS,
  handleFrameLinkClick,
} from "@/utils/attachments/docx-frame";

const SVG = "http://www.w3.org/2000/svg";
const PIXEL = "data:image/png;base64,iVBORw0KGgo=";

describe("createFrameElementFactory", () => {
  it("builds in the frame's document, so the frame's CSP governs loads", () => {
    const frameDoc = document.implementation.createHTMLDocument("frame");
    const h = createFrameElementFactory(frameDoc);

    const node = h({ tagName: "p", children: ["Hello"] }) as Element;

    expect(node.ownerDocument).toBe(frameDoc);
    expect(node.textContent).toBe("Hello");
  });

  // docx-preview sets null for a missing or external image part, which
  // would request "<app>/null"; a remote URL would be a tracking pixel.
  it("only ever gives an image an embedded source", () => {
    const h = createFrameElementFactory(document);
    const img = (src: unknown) => {
      const element = h({ tagName: "img" }) as HTMLImageElement;
      (element as unknown as { src: unknown }).src = src;
      return element.getAttribute("src");
    };

    expect(img(null)).toBeNull();
    expect(img("https://tracker.example/pixel.png")).toBeNull();
    expect(img("blob:https://app.example/1")).toBeNull();
    expect(img(PIXEL)).toBe(PIXEL);
  });

  it("only gives a drawing's image an embedded href", () => {
    const h = createFrameElementFactory(document);
    const image = h({ ns: SVG, tagName: "image" }) as Element;

    image.setAttribute("href", "https://tracker.example/pixel.png");
    image.setAttribute("xlink:href", "null");
    expect(image.getAttribute("href")).toBeNull();
    expect(image.getAttribute("xlink:href")).toBeNull();

    image.setAttribute("href", PIXEL);
    expect(image.getAttribute("href")).toBe(PIXEL);
  });

  it("drops embedded pages and plugins", () => {
    const h = createFrameElementFactory(document);
    for (const tagName of ["iframe", "object", "embed", "script"])
      expect(h({ tagName, srcdoc: "<p>hi</p>" }).nodeType).toBe(
        Node.COMMENT_NODE,
      );
  });
});

describe("rendering a hostile document", () => {
  // External hyperlink, remote and missing images, and an altChunk page with
  // a remote image, @import and script.
  it("keeps every remote reference out of the rendered frame", async () => {
    const frameDoc = document.implementation.createHTMLDocument("frame");
    const styles = frameDoc.createElement("div");
    const body = frameDoc.createElement("div");
    frameDoc.body.append(styles, body);
    const file = readFileSync(
      "__tests__/playwright/emulated/mail/fixtures/hostile.docx",
    );

    await renderAsync(new Blob([file]), body, styles, {
      ...DOCX_RENDER_OPTIONS,
      h: createFrameElementFactory(frameDoc),
    });

    expect(body.textContent).toContain("Hostile document");
    expect(body.textContent).toContain("End of hostile document");
    expect(body.textContent).not.toContain("Embedded page");
    expect(body.querySelectorAll("iframe, script, object, embed")).toHaveLength(
      0,
    );
    for (const img of body.querySelectorAll("img"))
      expect(img.getAttribute("src")).toBeNull();
    expect(frameDoc.documentElement.innerHTML).not.toContain("tracker.invalid");
    expect(body.querySelector("a")?.getAttribute("href")).toBe(
      "https://phish.invalid/login",
    );
  });
});

describe("handleFrameLinkClick", () => {
  it.each([
    "https://example.com/plan",
    "http://example.com/",
    "mailto:someone@example.com",
  ])("opens %s in a new tab instead of navigating the frame", (href) => {
    const { event, open } = clickLink(href);
    expect(event.defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledWith(new URL(href).href);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<p>hi</p>",
    "",
    "file:///etc/passwd",
  ])("neither follows nor opens %j", (href) => {
    const { event, open } = clickLink(href);
    expect(event.defaultPrevented).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("scrolls to a bookmark in the document", () => {
    const target = document.createElement("span");
    target.id = "section-2";
    target.scrollIntoView = vi.fn();
    document.body.append(target);

    const { event, open } = clickLink("#section-2");

    expect(event.defaultPrevented).toBe(true);
    expect(target.scrollIntoView).toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
    target.remove();
  });
});

function clickLink(href: string) {
  const link = document.createElement("a");
  link.setAttribute("href", href);
  const text = document.createElement("span");
  link.append(text);
  document.body.append(link);
  const open = vi.fn();
  const event = new MouseEvent("click", { bubbles: true, cancelable: true });
  link.addEventListener("click", (clicked) =>
    handleFrameLinkClick(clicked, open),
  );
  text.dispatchEvent(event);
  link.remove();
  return { event, open };
}
