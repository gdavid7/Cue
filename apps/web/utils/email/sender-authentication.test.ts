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

  it("accepts a DKIM signature aligned with the sender's domain when there is no DMARC policy", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@mail.northwind.com",
          "mx.google.com; dkim=pass header.i=@northwind.com header.s=s1; spf=pass smtp.mailfrom=bounce@esp.example; dmarc=none header.from=mail.northwind.com",
        ),
      ),
    ).toBe(true);
  });

  it("refuses a sender that only passed SPF for another domain", () => {
    expect(
      isAuthenticatedSender(
        message(
          "nora@northwind.com",
          "mx.google.com; spf=pass smtp.mailfrom=bounce@esp.example; dkim=pass header.i=@esp.example; dmarc=fail (p=NONE) header.from=northwind.com",
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
