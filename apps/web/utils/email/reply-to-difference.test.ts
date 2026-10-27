import { describe, expect, it } from "vitest";
import { getReplyToDifference } from "./reply-to-difference";

describe("getReplyToDifference", () => {
  it("returns the Reply-To address when it is at another domain", () => {
    expect(
      getReplyToDifference({
        from: "Ana Ruiz <ana@supplier.com>",
        "reply-to": "billing@payments-desk.net",
      }),
    ).toEqual({
      addresses: ["billing@payments-desk.net"],
      sender: "Ana Ruiz",
      senderRecipient: "Ana Ruiz <ana@supplier.com>",
    });
  });

  it("names the sender by address when From has no display name", () => {
    expect(
      getReplyToDifference({
        from: "ana@supplier.com",
        "reply-to": "Billing <billing@payments-desk.net>",
      })?.sender,
    ).toBe("ana@supplier.com");
  });

  it("stays quiet for a different address at the same domain", () => {
    expect(
      getReplyToDifference({
        from: "ana@supplier.com",
        "reply-to": "support@supplier.com",
      }),
    ).toBeNull();
  });

  it("treats subdomains of one registrable domain as the same domain", () => {
    expect(
      getReplyToDifference({
        from: "news@mail.supplier.com",
        "reply-to": "help@support.supplier.com",
      }),
    ).toBeNull();
  });

  it("compares domains without regard to case", () => {
    expect(
      getReplyToDifference({
        from: "ana@Supplier.COM",
        "reply-to": "Billing@SUPPLIER.com",
      }),
    ).toBeNull();
  });

  it("tells apart two organizations under one public suffix", () => {
    expect(
      getReplyToDifference({
        from: "ana@supplier.co.uk",
        "reply-to": "billing@other.co.uk",
      })?.addresses,
    ).toEqual(["billing@other.co.uk"]);
  });

  it("returns only the Reply-To addresses at another domain", () => {
    expect(
      getReplyToDifference({
        from: "ana@supplier.com",
        "reply-to":
          "team@supplier.com, Billing <billing@payments-desk.net>, BILLING@payments-desk.net",
      })?.addresses,
    ).toEqual(["billing@payments-desk.net"]);
  });

  it("stays quiet when every Reply-To address is at the sender's domain", () => {
    expect(
      getReplyToDifference({
        from: "ana@supplier.com",
        "reply-to": "team@supplier.com, ops@eu.supplier.com",
      }),
    ).toBeNull();
  });

  it("stays quiet without a Reply-To header", () => {
    expect(getReplyToDifference({ from: "ana@supplier.com" })).toBeNull();
    expect(
      getReplyToDifference({ from: "ana@supplier.com", "reply-to": "" }),
    ).toBeNull();
  });

  it("stays quiet when From has no address to reply to instead", () => {
    expect(
      getReplyToDifference({
        from: "",
        "reply-to": "billing@payments-desk.net",
      }),
    ).toBeNull();
  });
});
