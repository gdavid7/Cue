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
      "https://urldefense.com/v3/__https://evil.example__",
    ]) {
      expect(getMismatchedLinkHost("example.com", href), href).toBeNull();
    }
  });

  it("compares the destination inside a Safe Links wrapper", () => {
    expect(
      getMismatchedLinkHost(
        "example.com",
        "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fevil.example%2Flogin&data=1",
      ),
    ).toBe("evil.example");
    expect(
      getMismatchedLinkHost(
        "example.com",
        "https://nam12.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.example.com%2F",
      ),
    ).toBeNull();
    expect(
      getMismatchedLinkHost(
        "example.com",
        "https://nam12.safelinks.protection.outlook.com/?data=1",
      ),
    ).toBeNull();
  });

  it("ignores file names linking to where the file lives", () => {
    for (const text of [
      "report.pdf",
      "package.json",
      "Q3-Budget.xlsx",
      "Node.js",
      "schema.prisma",
      "index.ts",
      "notes.zip",
    ]) {
      expect(
        getMismatchedLinkHost(text, "https://github.com/acme/repo"),
        text,
      ).toBeNull();
      expect(
        getMismatchedLinkHost(text, "https://drive.google.com/file/d/1"),
        text,
      ).toBeNull();
    }
  });

  it("still reads ICANN, private and Unicode names as hosts", () => {
    for (const text of [
      "paypal.com",
      "bank.co.uk",
      "alice.github.io",
      "bücher.de",
    ]) {
      expect(getMismatchedLinkHost(text, "https://evil.example/"), text).toBe(
        "evil.example",
      );
    }
  });

  it("parses hrefs the way the browser does", () => {
    for (const href of [
      "\\\\evil.example/",
      "/\\evil.example/",
      "https:\\\\evil.example/",
      "ht\ntps://evil.example/",
      "\thttps://evil.example/",
    ]) {
      expect(getMismatchedLinkHost("paypal.com", href), href).toBe(
        "evil.example",
      );
    }
    for (const href of ["account", "?x=1", "#top", "javascript:alert(1)"]) {
      expect(getMismatchedLinkHost("paypal.com", href), href).toBeNull();
    }
  });

  it("flags IP address destinations when the text shows a host", () => {
    expect(
      getMismatchedLinkHost("paypal.com", "http://203.0.113.5/login"),
    ).toBe("203.0.113.5");
    expect(getMismatchedLinkHost("paypal.com", "http://[2001:db8::1]/")).toBe(
      "[2001:db8::1]",
    );
    expect(
      getMismatchedLinkHost("Click here", "http://203.0.113.5/"),
    ).toBeNull();
  });

  it("ignores invisible format characters in the text", () => {
    for (const text of [
      "pay\u200Bpal.com",
      "https://pay\u200Bpal.com",
      "pay\u00ADpal.com",
      "\u2060paypal.com\uFEFF",
    ]) {
      expect(getMismatchedLinkHost(text, "https://evil.example/"), text).toBe(
        "evil.example",
      );
    }
    expect(
      getMismatchedLinkHost("pay\u200Bpal.com", "https://paypal.com/"),
    ).toBeNull();
  });

  it("skips common email-service click-tracking hosts", () => {
    for (const href of [
      "https://substack.com/redirect/2/abc?j=x",
      "https://klclick.com/ls/click?upn=x",
      "https://klclick3.com/ls/click?upn=x",
      "https://abc.hubspotlinks.com/Ctc/x",
      "https://hubspotlinks.com/Ctc/x",
      "https://abc.mjt.lu/lnk/x",
      "https://abc.sendibt3.com/tr/cl/x",
      "https://abc.convertkit-mail2.com/x",
      "https://link.mail.beehiiv.com/ss/c/x",
    ]) {
      expect(getMismatchedLinkHost("example.com/offer", href), href).toBeNull();
    }
  });

  it("still flags other pages on a host that only has a redirect path", () => {
    expect(
      getMismatchedLinkHost("example.com", "https://substack.com/home"),
    ).toBe("substack.com");
  });

  it("ignores a trailing dot on the destination and the shown host", () => {
    expect(
      getMismatchedLinkHost("example.com", "https://example.com./login"),
    ).toBeNull();
    expect(
      getMismatchedLinkHost("https://example.com./", "https://example.com/"),
    ).toBeNull();
    expect(
      getMismatchedLinkHost("paypal.com", "https://evil.example./login"),
    ).toBe("evil.example");
    expect(
      getMismatchedLinkHost("example.com", "https://abc.mjt.lu./lnk/x"),
    ).toBeNull();
  });
});
