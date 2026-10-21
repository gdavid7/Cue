import { describe, expect, it } from "vitest";
import { linkifyPlainText } from "./linkify";

describe("linkifyPlainText", () => {
  it("finds web and email links while preserving the surrounding text", () => {
    const text =
      "Visit service.new/account or https://staging.example.com/verify?token=value.\nEmail support@example.com.";

    const result = linkifyPlainText(text);

    expect(result).toEqual([
      { type: "text", text: "Visit " },
      {
        type: "link",
        text: "service.new/account",
        href: "http://service.new/account",
      },
      { type: "text", text: " or " },
      {
        type: "link",
        text: "https://staging.example.com/verify?token=value",
        href: "https://staging.example.com/verify?token=value",
      },
      { type: "text", text: ".\nEmail " },
      {
        type: "link",
        text: "support@example.com",
        href: "mailto:support@example.com",
      },
      { type: "text", text: "." },
    ]);
  });

  it("leaves unsupported protocols as plain text", () => {
    const text = "Files: ftp://example.com/file";

    expect(linkifyPlainText(text)).toEqual([{ type: "text", text }]);
  });

  it("links a very long tracking URL in full", () => {
    const text = `Track it: ${LONG_TRACKING_URL}\nThanks`;

    expect(linkifyPlainText(text)).toEqual([
      { type: "text", text: "Track it: " },
      { type: "link", text: LONG_TRACKING_URL, href: LONG_TRACKING_URL },
      { type: "text", text: "\nThanks" },
    ]);
  });

  it("links a URL the sender wrapped across lines inside angle brackets", () => {
    const wrapped = `${LONG_TRACKING_URL.slice(0, 76)}\n${LONG_TRACKING_URL.slice(76, 152)}\r\n  ${LONG_TRACKING_URL.slice(152)}`;
    const text = `Reset your password:\n<${wrapped}>\nThanks`;

    expect(linkifyPlainText(text)).toEqual([
      { type: "text", text: "Reset your password:\n<" },
      { type: "link", text: wrapped, href: LONG_TRACKING_URL },
      { type: "text", text: ">\nThanks" },
    ]);
  });

  it("does not join words across a space inside angle brackets", () => {
    const text = "<https://example.com/a and\nmore>";

    expect(linkifyPlainText(text)).toEqual([
      { type: "text", text: "<" },
      {
        type: "link",
        text: "https://example.com/a",
        href: "https://example.com/a",
      },
      { type: "text", text: " and\nmore>" },
    ]);
  });
  it("stops linking past ~100KB so a huge body stays fast", () => {
    const filler = "word ".repeat(30_000);
    const text = `https://first.example.com ${filler}https://last.example.com`;

    const links = linkifyPlainText(text).filter(
      (segment) => segment.type === "link",
    );

    expect(links).toEqual([
      {
        type: "link",
        text: "https://first.example.com",
        href: "https://first.example.com/",
      },
    ]);
    expect(
      linkifyPlainText(text)
        .map((segment) => segment.text)
        .join(""),
    ).toBe(text);
  });
});

const LONG_TRACKING_URL = `https://click.mail.example.com/ls/click?upn=${"u001.aB3-_x%2F9".repeat(18)}&utm_source=newsletter`;
