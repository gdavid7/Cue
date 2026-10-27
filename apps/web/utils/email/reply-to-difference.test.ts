import { describe, expect, it, vi } from "vitest";
import { extractDomainFromEmail } from "@/utils/email";
import { getReplyToDifference } from "./reply-to-difference";

vi.mock("@/utils/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/email")>();
  return {
    ...actual,
    extractDomainFromEmail: vi.fn(actual.extractDomainFromEmail),
  };
});

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

  // The address parsers rarely let this through, so it is forced here: an
  // unreadable domain must never pass as the sender's own organization.
  it("flags a Reply-To whose domain can't be read, or when From's can't", () => {
    const headers = {
      from: "ana@supplier.com",
      "reply-to": "billing@supplier.com",
    };
    vi.mocked(extractDomainFromEmail).mockImplementation((address) =>
      address === "billing@supplier.com" ? "" : "supplier.com",
    );
    expect(getReplyToDifference(headers)?.addresses).toEqual([
      "billing@supplier.com",
    ]);
    vi.mocked(extractDomainFromEmail).mockImplementation(() => "");
    expect(getReplyToDifference(headers)?.addresses).toEqual([
      "billing@supplier.com",
    ]);
    vi.mocked(extractDomainFromEmail).mockRestore();
  });
});
