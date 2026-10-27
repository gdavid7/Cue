import { describe, expect, it } from "vitest";
import { getMismatchedLinkHost } from "./link-destination";

describe("getMismatchedLinkHost", () => {
  it("returns the real host when the text shows another address", () => {
    expect(
      getMismatchedLinkHost("paypal.com/verify", "https://evil.example/login"),
    ).toBe("evil.example");
    expect(
      getMismatchedLinkHost(
        "https://www.paypal.com/signin",
        "http://login.evil.example/",
      ),
    ).toBe("login.evil.example");
    expect(
      getMismatchedLinkHost("(paypal.com).", "https://evil.example/"),
    ).toBe("evil.example");
  });

  it("does not flag the same registrable domain", () => {
    for (const [text, href] of [
      ["www.example.com", "https://example.com/"],
      ["example.com", "https://www.example.com/"],
      ["example.com/account", "https://login.mail.example.com/account?x=1"],
      ["Example.COM", "https://example.com/"],
      ["https://shop.example.co.uk/sale", "https://example.co.uk/"],
    ]) {
      expect(getMismatchedLinkHost(text, href), text).toBeNull();
    }
  });

  it("compares registrable domains under multi-label and private suffixes", () => {
    expect(getMismatchedLinkHost("bank.co.uk", "https://other.co.uk/")).toBe(
      "other.co.uk",
    );
    expect(
      getMismatchedLinkHost("alice.github.io", "https://mallory.github.io/"),
    ).toBe("mallory.github.io");
  });

  it("ignores text that is not an address", () => {
    for (const text of [
      "Click here",
      "Sign in to example.com",
      "",
      "v1.2",
      "README.md",
      "support@example.com",
    ]) {
      expect(
        getMismatchedLinkHost(text, "https://evil.example/"),
        text,
      ).toBeNull();
    }
  });

  it("ignores mailto and tel links", () => {
    expect(
      getMismatchedLinkHost("example.com", "mailto:someone@evil.example"),
    ).toBeNull();
    expect(getMismatchedLinkHost("example.com", "tel:+15555550100")).toBeNull();
    expect(
      getMismatchedLinkHost("help@example.com", "mailto:help@example.com"),
    ).toBeNull();
  });

  it("ignores relative and unparseable hrefs", () => {
    expect(getMismatchedLinkHost("example.com", "/account")).toBeNull();
    expect(getMismatchedLinkHost("example.com", "https://")).toBeNull();
  });

  it("treats protocol-relative hrefs as https", () => {
    expect(getMismatchedLinkHost("example.com", "//evil.example/")).toBe(
      "evil.example",
    );
  });

  it("compares Unicode and punycode names as one, and shows look-alikes in punycode", () => {
    expect(
      getMismatchedLinkHost("shop.bücher.de", "https://xn--bcher-kva.de/"),
    ).toBeNull();
    expect(
      getMismatchedLinkHost("bücher.de", "https://xn--bcher-kva.de/"),
    ).toBeNull();
    // "pаypal.com" with a Cyrillic а.
    expect(getMismatchedLinkHost("paypal.com", "https://pаypal.com/")).toBe(
      "xn--pypal-4ve.com",
    );
  });

  it("skips known click-tracking and link-scanning hosts", () => {
    for (const href of [
      "https://example.us1.list-manage.com/track/click?u=1",
      "https://u123.ct.sendgrid.net/ls/click?upn=abc",
      "https://r.us-east-1.awstrack.me/L0/https:%2F%2Fexample.com",
      "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fexample.com",
      "https://urldefense.com/v3/__https://example.com__",
    ]) {
      expect(getMismatchedLinkHost("example.com", href), href).toBeNull();
    }
  });
});
