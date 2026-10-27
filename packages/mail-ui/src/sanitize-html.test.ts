/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { EMAIL_DOCUMENT_MARKER, buildMailHtmlDocument } from "./MailBody";
import { sanitizeMailHtml } from "./sanitize-html";

describe("sanitizeMailHtml", () => {
  it("removes executable content from complete email documents", () => {
    const sanitized = sanitizeMailHtml(`
      <html>
        <body onload="alert('unsafe')">
          <script>alert("unsafe")</script>
          <img src="https://example.com/image.png" onerror="alert('unsafe')">
          <a href="javascript:alert('unsafe')">bad link</a>
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
    expect(parsedDocument.querySelector("a")?.getAttribute("href")).toBeNull();
  });

  it("builds the iframe document through DOM nodes instead of string wrappers", () => {
    const sanitized = sanitizeMailHtml(`
      <section data-testid="message">
        <p>Readable <strong>content</strong></p>
      </section>
    `).html;
    const document = buildMailHtmlDocument({
      html: sanitized,
      darkTreatment: "theme",
      imageProxyBaseUrl: null,
      imageProxyOrigin: null,
      documentKey: "fragment-document",
      allowRemoteImages: false,
    });
    const parsedDocument = new DOMParser().parseFromString(
      document,
      "text/html",
    );

    expect(
      parsedDocument
        .querySelector(`meta[name="${EMAIL_DOCUMENT_MARKER}"]`)
        ?.getAttribute("content"),
    ).toBe("fragment-document");
    expect(parsedDocument.documentElement.classList.contains("dark")).toBe(
      true,
    );
    expect(parsedDocument.body.classList.contains("dark")).toBe(true);
    expect(parsedDocument.body.textContent).toContain("Readable content");
    expect(parsedDocument.body.querySelector("section")?.textContent).toContain(
      "Readable content",
    );
    expect(parsedDocument.querySelectorAll("body")).toHaveLength(1);
  });

  it("pins authored color-scheme queries to the light palette when shown as sent", () => {
    const sanitized = sanitizeMailHtml(`
      <html>
        <head>
          <style>
            @media (prefers-color-scheme: dark) { body { color: white; } }
            @media (prefers-color-scheme: light) { body { color: black; } }
          </style>
        </head>
        <body bgcolor="#ffffff">Styled content</body>
      </html>
    `).html;
    const document = buildMailHtmlDocument({
      html: sanitized,
      darkTreatment: "light",
      imageProxyBaseUrl: null,
      imageProxyOrigin: null,
      documentKey: "styled-document",
      allowRemoteImages: false,
    });
    const parsedDocument = new DOMParser().parseFromString(
      document,
      "text/html",
    );
    const authoredStyle = Array.from(parsedDocument.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .find((style) => style.includes("body { color: white; }"));

    // The frame follows the operating system's preference, so the sender's
    // queries are pinned to the light palette the reader is showing.
    expect(authoredStyle).not.toContain("prefers-color-scheme");
    expect(authoredStyle).toContain(
      "@media (max-width: 0px) { body { color: white; } }",
    );
    expect(authoredStyle).toContain(
      "@media (min-width: 0px) { body { color: black; } }",
    );
    expect(parsedDocument.body.textContent).toContain("Styled content");
  });

  it("keeps sanitized iframe documents inert under the shared body CSP", () => {
    const sanitized = sanitizeMailHtml(`
      <div onclick="alert('unsafe')">Readable content</div>
      <script>alert("unsafe")</script>
    `).html;
    const document = buildMailHtmlDocument({
      html: sanitized,
      darkTreatment: "light",
      imageProxyBaseUrl: null,
      imageProxyOrigin: null,
      documentKey: "test-document",
      allowRemoteImages: false,
    });
    const parsedDocument = new DOMParser().parseFromString(
      document,
      "text/html",
    );
    const csp = parsedDocument.querySelector(
      'meta[http-equiv="Content-Security-Policy"]',
    );

    expect(parsedDocument.querySelector("script")).toBeNull();
    expect(parsedDocument.querySelector("div")?.hasAttribute("onclick")).toBe(
      false,
    );
    expect(csp?.getAttribute("content")).toContain("script-src 'none'");
    expect(csp?.getAttribute("content")).toContain("img-src data:");
    expect(csp?.getAttribute("content")).not.toContain("https:");
  });

  it("uses only CSP directives browsers recognise", () => {
    // Chrome logs a console error for every frame that names an unknown
    // directive, so one stray directive floods the console of every thread.
    const document = buildMailHtmlDocument({
      html: "<p>Hello</p>",
      darkTreatment: "light",
      imageProxyBaseUrl: null,
      imageProxyOrigin: null,
      documentKey: "test-document",
      allowRemoteImages: false,
    });
    const content = new DOMParser()
      .parseFromString(document, "text/html")
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute("content");
    const directives = (content ?? "")
      .split(";")
      .map((directive) => directive.trim().split(/\s+/)[0])
      .filter(Boolean);

    expect(directives.length).toBeGreaterThan(0);
    for (const directive of directives) {
      expect(RECOGNISED_CSP_DIRECTIVES).toContain(directive);
    }
  });
});

describe("sanitizeMailHtml links bare URLs", () => {
  it("turns a long bare URL in a text node into a link that opens a new tab", () => {
    const html = sanitizeMailHtml(
      `<div><p>Confirm here: ${LONG_TRACKING_URL} before Friday.</p></div>`,
    ).html;
    const links = parse(html).querySelectorAll("a");

    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(LONG_TRACKING_URL);
    expect(links[0]?.textContent).toBe(LONG_TRACKING_URL);
    expect(links[0]?.getAttribute("target")).toBe("_blank");
    expect(links[0]?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(parse(html).body.textContent).toBe(
      `Confirm here: ${LONG_TRACKING_URL} before Friday.`,
    );
  });

  it("links a URL wrapped onto several lines inside angle brackets", () => {
    const wrapped = `${LONG_TRACKING_URL.slice(0, 70)}\n${LONG_TRACKING_URL.slice(70)}`;
    const html = sanitizeMailHtml(
      `<pre>Open &lt;${wrapped}&gt; now</pre>`,
    ).html;
    const links = parse(html).querySelectorAll("a");

    expect(links).toHaveLength(1);
    expect(links[0]?.getAttribute("href")).toBe(LONG_TRACKING_URL);
  });

  it("leaves existing links, styles and unsafe schemes as they were", () => {
    const html = sanitizeMailHtml(`
      <style>a { background: url(https://example.com/bg.png); }</style>
      <a href="https://example.com/real">https://example.com/shown</a>
      <p>javascript:alert(1) and ftp://example.com/file</p>
    `).html;
    const document = parse(html);

    expect(document.querySelectorAll("a")).toHaveLength(1);
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/real",
    );
    expect(document.querySelector("style")?.textContent).toContain(
      "url(https://example.com/bg.png)",
    );
  });

  it("keeps markup-like text in a URL as text instead of elements", () => {
    const html = sanitizeMailHtml(
      `<p>https://example.com/a?b=1&amp;c="&gt;&lt;img src=x onerror=alert(1)&gt;</p>`,
    ).html;
    const document = parse(html);

    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/a?b=1&c=",
    );
    expect(document.body.textContent).toBe(
      `https://example.com/a?b=1&c="><img src=x onerror=alert(1)>`,
    );
  });
  it("stops linking past ~100KB of text across the document", () => {
    const filler = `<p>${"version 1.2.3 ".repeat(400)}</p>`.repeat(30);
    const html = sanitizeMailHtml(
      `<p>https://first.example.com</p>${filler}<p>https://last.example.com</p>`,
    ).html;

    expect(
      Array.from(parse(html).querySelectorAll("a"), (a) => a.href),
    ).toEqual(["https://first.example.com/"]);
  });
});

describe("sanitizeMailHtml hides tracking images", () => {
  it("removes and counts trackers but keeps visible images", () => {
    const { html, hiddenCount } = sanitizeMailHtml(`
      <p>Hi</p>
      <img src="https://cdn.example.com/logo.png" width="120" height="40">
      <img src="https://e.example.com/a" width="1" height="1">
      <img src="https://mailtrack.io/trace/mail/x.png">
    `);

    expect(hiddenCount).toBe(2);
    expect(
      Array.from(parse(html).querySelectorAll("img"), (image) =>
        image.getAttribute("src"),
      ),
    ).toEqual(["https://cdn.example.com/logo.png"]);
  });

  it("drops images matched by dropImage without counting them", () => {
    const { html, hiddenCount } = sanitizeMailHtml(
      '<p>Hi</p><img src="https://app.example.com/own" width="1" height="1"><img src="https://e.example.com/a" width="1" height="1">',
      { dropImage: (src) => src === "https://app.example.com/own" },
    );

    expect(hiddenCount).toBe(1);
    expect(parse(html).querySelectorAll("img")).toHaveLength(0);
    expect(parse(html).body.textContent).toBe("Hi");
  });

  it("does not revive markup the sanitizer removed when an attribute holds a fake image tag", () => {
    const { html, hiddenCount } = sanitizeMailHtml(
      `<a title="<img src=//t/ width=1 height=1 alt='">x'</a><span title="x href=javascript:alert(document.domain) target=_blank style=display:block;position:fixed;inset:0 z">Click</span>`,
    );
    const document = parse(html);
    const anchor = document.querySelector("a");

    expect(hiddenCount).toBe(0);
    expect(anchor?.hasAttribute("href")).toBe(false);
    expect(anchor?.hasAttribute("style")).toBe(false);
    expect(anchor?.getAttribute("title")).toBe(
      "<img src=//t/ width=1 height=1 alt='",
    );
    expect(document.querySelector("[href^='javascript' i]")).toBeNull();
    expect(document.querySelector("span")?.getAttribute("title")).toContain(
      "href=javascript:alert",
    );
  });

  it("returns an empty document with nothing hidden for empty html", () => {
    expect(sanitizeMailHtml("").hiddenCount).toBe(0);
  });
});

describe("sanitizeMailHtml marks links that go somewhere else", () => {
  it("counts mismatched links and titles each with its real host", () => {
    const { html, mismatchedLinkCount } = sanitizeMailHtml(`
      <p><a href="https://evil.example/login">paypal.com/verify</a></p>
      <p><a href="https://login.other.example/" title="Sign in">www.bank.example.com</a></p>
      <p><a href="https://www.example.com/">example.com</a></p>
      <p><a href="https://evil.example/">Click here</a></p>
      <p><a href="mailto:help@evil.example">example.com</a></p>
      <p><a href="https://u1.ct.sendgrid.net/ls/click?upn=x">example.com</a></p>
      <p>Bare https://example.org stays linked.</p>
    `);
    const anchors = Array.from(parse(html).querySelectorAll("a"));

    expect(mismatchedLinkCount).toBe(2);
    expect(anchors.map((anchor) => anchor.getAttribute("title"))).toEqual([
      "evil.example",
      "login.other.example",
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it("flags hrefs the browser resolves to another host", () => {
    const { html, mismatchedLinkCount } = sanitizeMailHtml(`
      <a href="\\\\evil.example/">paypal.com</a>
      <a href="/\\evil.example/">paypal.com</a>
      <a href="ht&#10;tps://evil.example/">paypal.com</a>
      <a href="/account">paypal.com</a>
    `);
    const anchors = Array.from(parse(html).querySelectorAll("a"));

    expect(mismatchedLinkCount).toBe(3);
    expect(anchors.map((anchor) => anchor.getAttribute("title"))).toEqual([
      "evil.example",
      "evil.example",
      "evil.example",
      null,
    ]);
  });

  it("changes nothing but the title", () => {
    const input =
      '<p>Hi <a href="https://evil.example/a" class="btn" target="_blank">paypal.com</a></p>';
    const flagged = sanitizeMailHtml(input);
    const plain = sanitizeMailHtml(input.replace("paypal.com", "Open"));

    expect(flagged.mismatchedLinkCount).toBe(1);
    expect(
      flagged.html
        .replace(' title="evil.example"', "")
        .replace("paypal.com", "Open"),
    ).toBe(plain.html);
  });

  it("counts nothing in an email without links", () => {
    expect(sanitizeMailHtml("<p>Hello</p>").mismatchedLinkCount).toBe(0);
    expect(sanitizeMailHtml("").mismatchedLinkCount).toBe(0);
  });
});

const LONG_TRACKING_URL = `https://click.mail.example.com/ls/click?upn=${"u001.aB3-_x%2F9".repeat(18)}&utm_source=newsletter`;

function parse(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

// CSP Level 3 fetch, document and navigation directives that Chrome, Firefox
// and Safari all parse. `prefetch-src` was dropped from the spec and is not.
const RECOGNISED_CSP_DIRECTIVES = [
  "default-src",
  "script-src",
  "style-src",
  "img-src",
  "font-src",
  "media-src",
  "connect-src",
  "manifest-src",
  "worker-src",
  "child-src",
  "frame-src",
  "object-src",
  "base-uri",
  "form-action",
];
