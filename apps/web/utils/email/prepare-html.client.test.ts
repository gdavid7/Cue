/** @vitest-environment jsdom */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BASE_URL: "https://app.example.com",
    NEXT_PUBLIC_IMAGE_PROXY_BASE_URL: "https://img.example.com/proxy",
    NEXT_PUBLIC_IMAGE_PROXY_USE_APP_ROUTE: true,
  },
}));

import { sanitizeEmailHtml } from "./prepare-html.client";

describe("sanitizeEmailHtml", () => {
  it("wraps and sanitizes email fragments as complete documents", () => {
    const sanitized = sanitizeEmailHtml(
      "<div onclick=\"alert('unsafe')\">Readable content</div>",
    ).html;
    const parsedDocument = new DOMParser().parseFromString(
      sanitized,
      "text/html",
    );

    expect(sanitized).toMatch(/^<!doctype html><html><head><\/head><body>/i);
    expect(parsedDocument.body.innerHTML).toBe("<div>Readable content</div>");
  });

  it("preserves document-level styles used by email content", () => {
    const sanitized = sanitizeEmailHtml(`
      <!doctype html>
      <html lang="en">
        <head><style>p { margin: 0; }</style></head>
        <body style="background: #222; color: #eee">
          <div>Readable content</div>
        </body>
      </html>
    `).html;

    const parsedDocument = new DOMParser().parseFromString(
      sanitized,
      "text/html",
    );

    expect(sanitized).toMatch(/^<!doctype html>/i);
    expect(parsedDocument.body.getAttribute("style")).toBe(
      "background: #222; color: #eee",
    );
    expect(parsedDocument.head.querySelector("style")?.textContent).toContain(
      "p { margin: 0; }",
    );
  });

  it("removes executable content from complete email documents", () => {
    const sanitized = sanitizeEmailHtml(`
      <html>
        <body onload="alert('unsafe')">
          <script>alert("unsafe")</script>
          <img src="https://example.com/image.png" onerror="alert('unsafe')">
        </body>
      </html>
    `).html;

    const parsedDocument = new DOMParser().parseFromString(
      sanitized,
      "text/html",
    );

    expect(parsedDocument.querySelector("script")).toBeNull();
    expect(parsedDocument.body.hasAttribute("onload")).toBe(false);
    expect(parsedDocument.querySelector("img")?.hasAttribute("onerror")).toBe(
      false,
    );
  });

  it("strips sent-message open pixels so viewing mail does not count as opened", () => {
    const { html, hiddenTrackerCount } = sanitizeEmailHtml(
      '<p>Hi</p><img src="https://app.example.com/t/abcdefghijklmnopqrstuvwxyz012345" width="1" height="1" alt="">',
    );

    expect(html).not.toContain("/t/abcdefghijklmnopqrstuvwxyz012345");
    expect(html).toContain("<p>Hi</p>");
    expect(hiddenTrackerCount).toBe(0);
  });

  it("removes and counts senders' tracking pixels but keeps visible images", () => {
    const { html, hiddenTrackerCount } = sanitizeEmailHtml(`
      <p>Hi</p>
      <img src="https://cdn.example.com/logo.png" width="24" height="24" alt="Logo">
      <img src="https://news.example.com/open/abc.gif" width="1" height="1" alt="">
      <img src="https://news.example.com/beacon" style="display:none;width:1px;height:1px">
      <img src="https://cdn.example.com/hero-mobile.jpg" class="show-mobile" style="display:none;mso-hide:all">
    `);
    const parsedDocument = new DOMParser().parseFromString(html, "text/html");

    expect(hiddenTrackerCount).toBe(2);
    expect(
      [...parsedDocument.querySelectorAll("img")].map((image) =>
        image.getAttribute("src"),
      ),
    ).toEqual([
      "https://cdn.example.com/logo.png",
      "https://cdn.example.com/hero-mobile.jpg",
    ]);
  });
});
