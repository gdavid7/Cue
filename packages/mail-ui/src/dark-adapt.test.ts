/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  adaptBackgroundColor,
  adaptMailDocumentForDarkMode,
  adaptTextColor,
  contrastRatio,
  DARK_MAIL_SURFACE,
  hasAuthoredDarkSupport,
  needsLightBacking,
  parseCssColor,
  relativeLuminance,
  type Rgb,
} from "./dark-adapt";
import { buildMailHtmlDocument, getMailDarkTreatment } from "./MailBody";
import { sanitizeMailHtml } from "./sanitize-html";

describe("adaptBackgroundColor", () => {
  it("moves white and light neutral fills to the dark surface", () => {
    expect(adaptBackgroundColor(hex("#ffffff"))).toEqual(DARK_MAIL_SURFACE);
    const card = adaptBackgroundColor(hex("#f4f4f4"));
    expect(card && relativeLuminance(card)).toBeLessThan(0.05);
  });

  it("keeps lighter fills nearer the surface so nested cards keep their order", () => {
    const page = adaptBackgroundColor(hex("#eeeeee"));
    const card = adaptBackgroundColor(hex("#ffffff"));
    expect(relativeLuminance(page!)).toBeGreaterThan(relativeLuminance(card!));
  });

  it("keeps the hue of pastel fills", () => {
    const adapted = adaptBackgroundColor(hex("#e8f0fe"));
    expect(relativeLuminance(adapted!)).toBeLessThan(0.08);
    expect(adapted!.b).toBeGreaterThan(adapted!.r);
  });

  it("leaves dark, mid-tone and vivid brand fills alone", () => {
    expect(adaptBackgroundColor(hex("#202124"))).toBeNull();
    expect(adaptBackgroundColor(hex("#777777"))).toBeNull();
    expect(adaptBackgroundColor(hex("#1a73e8"))).toBeNull();
    expect(adaptBackgroundColor(hex("#ffcc00"))).toBeNull();
    expect(adaptBackgroundColor(hex("#ff6600"))).toBeNull();
  });
});

describe("adaptTextColor", () => {
  const surface = DARK_MAIL_SURFACE;

  it.each([
    "#000000",
    "#202124",
    "#555555",
    "#1a0dab",
    "#0645ad",
    "#d93025",
    "#188038",
  ])("lifts %s to at least AA contrast on the dark surface", (color) => {
    const adapted = adaptTextColor(hex(color), surface);
    expect(adapted).not.toBeNull();
    expect(contrastRatio(adapted!, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it("reaches AA on every adapted fill, not just the page surface", () => {
    for (const fill of ["#ffffff", "#f1f3f4", "#e8f0fe", "#fff4e5"]) {
      const background = adaptBackgroundColor(hex(fill))!;
      for (const text of ["#000000", "#1a73e8", "#5f6368", "#c5221f"]) {
        const adapted = adaptTextColor(hex(text), background) ?? hex(text);
        expect(contrastRatio(adapted, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("turns black body text into the app's foreground tone", () => {
    expect(adaptTextColor(hex("#000000"), surface)).toEqual(hex("#e9eaec"));
  });

  it("keeps a link's hue while lightening it", () => {
    const adapted = adaptTextColor(hex("#1a0dab"), surface);
    expect(adapted!.b).toBeGreaterThan(adapted!.r);
    expect(adapted!.b).toBeGreaterThan(adapted!.g);
  });

  it("leaves text that already reads on the new background", () => {
    expect(adaptTextColor(hex("#ffffff"), surface)).toBeNull();
    expect(adaptTextColor(hex("#e8eaed"), surface)).toBeNull();
  });
});

describe("needsLightBacking", () => {
  it.each([
    "data:image/svg+xml;base64,PHN2Zy8+",
    "data:image/png;base64,iVBORw0KGgo=",
    "https://cdn.example.com/brand/logo.png",
    "https://cdn.example.com/logo.svg?v=3",
    "https://proxy.example.com/image?u=https%3A%2F%2Fx.example%2Flogo.gif&e=1&s=2",
    "blob:https://app.example.com/2b1c",
  ])("backs a small image that may be transparent: %s", (src) => {
    expect(needsLightBacking({ src, width: 140, height: 36 })).toBe(true);
  });

  it("leaves formats that cannot be transparent alone", () => {
    expect(
      needsLightBacking({
        src: "https://cdn.example.com/logo.jpg",
        width: 140,
        height: 36,
      }),
    ).toBe(false);
  });

  it("leaves photos and banners alone, and images whose size is unknown", () => {
    const src = "data:image/png;base64,iVBORw0KGgo=";
    expect(needsLightBacking({ src, width: 512, height: 180 })).toBe(false);
    expect(needsLightBacking({ src, width: 600, height: 80 })).toBe(false);
    expect(needsLightBacking({ src, width: 0, height: 0 })).toBe(false);
  });
});

describe("parseCssColor", () => {
  it("reads computed rgb and rgba values and hex", () => {
    expect(parseCssColor("rgb(1, 2, 3)")).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    expect(parseCssColor("rgba(1, 2, 3, 0.5)")).toEqual({
      r: 1,
      g: 2,
      b: 3,
      a: 0.5,
    });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseCssColor("transparent")?.a).toBe(0);
  });

  it("refuses color spaces it cannot place, so they stay as sent", () => {
    expect(parseCssColor("color(display-p3 1 0 0)")).toBeNull();
    expect(parseCssColor("oklch(0.7 0.1 200)")).toBeNull();
  });
});

describe("hasAuthoredDarkSupport", () => {
  it.each([
    '<meta name="color-scheme" content="light dark">',
    "<meta content='light dark' name='supported-color-schemes'>",
    "<style>:root { color-scheme: light dark; }</style>",
    "<style>@media (prefers-color-scheme: dark) { .a { color: #fff } }</style>",
  ])("detects %s", (html) => {
    expect(hasAuthoredDarkSupport(html)).toBe(true);
  });

  it.each([
    '<meta name="color-scheme" content="light">',
    "<style>:root { color-scheme: light only; }</style>",
    "<style>@media (prefers-color-scheme: light) { .a { color: #000 } }</style>",
    "<style>@media (prefers-color-scheme: light) { .dark-logo { display: none } }</style>",
    '<table bgcolor="#ffffff"><tr><td>Hello</td></tr></table>',
  ])("does not treat %s as dark support", (html) => {
    expect(hasAuthoredDarkSupport(html)).toBe(false);
  });
});

describe("getMailDarkTreatment", () => {
  const designed = '<table bgcolor="#ffffff"><tr><td>Hi</td></tr></table>';
  const designedWithDark = `<style>@media (prefers-color-scheme: dark) { td { color: #fff } }</style>${designed}`;
  const dark = { isDarkMode: true, adaptDesignedEmails: true };

  it("leaves light mode alone", () => {
    expect(getMailDarkTreatment(designed, { ...dark, isDarkMode: false })).toBe(
      "light",
    );
  });

  it("keeps theming plain emails even when designed emails are shown as sent", () => {
    expect(
      getMailDarkTreatment("<p>Hi</p>", {
        ...dark,
        adaptDesignedEmails: false,
      }),
    ).toBe("theme");
  });

  it("prefers the sender's own dark styles over adapting", () => {
    expect(getMailDarkTreatment(designedWithDark, dark)).toBe("authored");
    expect(getMailDarkTreatment(designed, dark)).toBe("adapt");
    expect(
      getMailDarkTreatment(designedWithDark, {
        ...dark,
        adaptDesignedEmails: false,
      }),
    ).toBe("light");
  });
});

describe("buildMailHtmlDocument with the sender's dark styles", () => {
  it("renders dark and turns on the sender's dark queries", () => {
    const document = buildMailHtmlDocument({
      html: sanitizeMailHtml(`<html><head><style>
        @media (prefers-color-scheme: dark) { .card { background: #202124; } }
      </style></head><body><div class="card" style="font-size:16px">Hi</div></body></html>`),
      darkTreatment: "authored",
      imageProxyBaseUrl: null,
      imageProxyOrigin: null,
      documentKey: "authored",
    });
    const parsed = new DOMParser().parseFromString(document, "text/html");
    const styles = Array.from(parsed.querySelectorAll("style"))
      .map((style) => style.textContent)
      .join("\n");

    expect(
      parsed
        .querySelector('meta[name="color-scheme"]')
        ?.getAttribute("content"),
    ).toBe("dark");
    expect(styles).toContain("@media (min-width: 0px) { .card");
    expect(styles).toContain("color-scheme: dark");
  });
});

describe("adaptMailDocumentForDarkMode", () => {
  it("leaves a document over the element cap exactly as sent", () => {
    const mailDocument = document.implementation.createHTMLDocument("");
    mailDocument.body.innerHTML = "<p>One</p><p>Two</p><p>Three</p>";
    const before = mailDocument.documentElement.outerHTML;

    expect(
      adaptMailDocumentForDarkMode(mailDocument, { maxElements: 2 }),
    ).toEqual({ adapted: false });
    expect(mailDocument.documentElement.outerHTML).toBe(before);
  });

  it("gives up without writing once the time budget is spent", () => {
    const mailDocument = document.implementation.createHTMLDocument("");
    mailDocument.body.innerHTML = "<p>x</p>".repeat(200);
    const before = mailDocument.documentElement.outerHTML;
    let clock = 0;

    expect(
      adaptMailDocumentForDarkMode(mailDocument, {
        budgetMs: 10,
        now: () => {
          clock += 100;
          return clock;
        },
      }),
    ).toEqual({ adapted: false });
    expect(mailDocument.documentElement.outerHTML).toBe(before);
  });
});

function hex(value: string): Rgb {
  const color = parseCssColor(value);
  if (!color) throw new Error(`Not a color: ${value}`);
  return { r: color.r, g: color.g, b: color.b };
}
