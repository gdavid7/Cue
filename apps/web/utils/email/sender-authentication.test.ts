import { describe, expect, it } from "vitest";
import { isAuthenticatedSender } from "./sender-authentication";

function message(from: string, results?: string) {
  return {
    headers: {
      from,
      ...(results ? { "authentication-results": results } : {}),
    },
  };
}

describe("isAuthenticatedSender", () => {
  it("accepts a sender whose domain passed DMARC at Gmail", () => {
    expect(
      isAuthenticatedSender(
        message(
          "Nora Patel <nora@northwind.com>",
          "mx.google.com; dkim=pass header.i=@northwind.com header.s=s1 header.b=abc; spf=pass (google.com: domain of nora@northwind.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=nora@northwind.com; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=northwind.com",
        ),
      ),
    ).toBe(true);
  });

  // The envelope sender is the attacker's to choose, and Gmail echoes it.
  it("ignores a verdict smuggled in through a quoted envelope sender", () => {
    expect(
      isAuthenticatedSender(
        message(
          "Bank <alerts@bank.com>",
          'mx.google.com; dkim=fail header.i=@bank.com header.s=s1; spf=pass (google.com: domain of "x; dmarc=pass header.from=bank.com y"@evil.com designates 1.2.3.4 as permitted sender) smtp.mailfrom="x; dmarc=pass header.from=bank.com y"@evil.com; dmarc=fail (p=REJECT sp=REJECT dis=QUARANTINE) header.from=bank.com',
        ),
      ),
    ).toBe(false);
  });

  it("ignores a verdict written inside a comment", () => {
    expect(
      isAuthenticatedSender(
        message(
          "alerts@bank.com",
          "mx.google.com; spf=neutral (note (dmarc=pass header.from=bank.com)) smtp.mailfrom=x@evil.com; dmarc=fail header.from=bank.com",
        ),
      ),
    ).toBe(false);
  });

  it("decides by the first DMARC result alone, whatever DKIM says", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@northwind.com",
          "mx.google.com; dkim=pass header.i=@northwind.com; dmarc=fail (p=NONE) header.from=northwind.com; dmarc=pass header.from=northwind.com",
        ),
      ),
    ).toBe(false);
  });

  it("falls back to DKIM from the sender's own domain when there's no DMARC result", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@mail.northwind.com",
          "mx.google.com; dkim=pass header.i=@northwind.com header.s=s1; spf=pass smtp.mailfrom=bounce@esp.example",
        ),
      ),
    ).toBe(true);
  });

  it("doesn't count DKIM from another domain", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@northwind.com",
          "mx.google.com; dkim=pass header.d=esp.example; spf=pass smtp.mailfrom=bounce@esp.example",
        ),
      ),
    ).toBe(false);
  });

  // Anyone can register a name under github.io or duckdns.org.
  it("treats names under a shared hosting suffix as separate senders", () => {
    expect(
      isAuthenticatedSender(
        message(
          "alice@alice.github.io",
          "mx.google.com; dkim=pass header.d=mallory.github.io",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a DMARC pass for a different domain than the From address", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@northwind.com",
          "mx.google.com; dmarc=pass header.from=attacker.example",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a verdict from any server but Gmail's", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@northwind.com",
          "attacker.example; dmarc=pass header.from=northwind.com",
        ),
      ),
    ).toBe(false);
  });

  it("refuses a message without authentication results", () => {
    expect(isAuthenticatedSender(message("nora@northwind.com"))).toBe(false);
  });
});
