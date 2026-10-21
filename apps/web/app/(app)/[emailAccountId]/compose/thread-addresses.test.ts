import { describe, expect, it } from "vitest";
import { getThreadAddresses } from "./thread-addresses";

const message = (
  headers: { from: string; to: string; cc?: string; "reply-to"?: string },
  labelIds: string[] = [],
) => ({ headers, labelIds });

describe("getThreadAddresses", () => {
  it("gathers everyone from every message in the thread", () => {
    const { participants } = getThreadAddresses([
      message({ from: "Alex <alex@example.com>", to: "me@example.com" }),
      message(
        {
          from: "me@example.com",
          to: "sam@example.com",
          cc: "lee@example.com",
        },
        ["SENT"],
      ),
      message({
        from: "kim@example.com",
        to: "me@example.com",
        "reply-to": "kim-replies@example.com",
      }),
    ]);

    expect(participants).toContain("alex@example.com");
    expect(participants).toContain("sam@example.com");
    expect(participants).toContain("lee@example.com");
    expect(participants).toContain("kim-replies@example.com");
  });

  it("leaves out unsent drafts, whose recipients may be new", () => {
    const { participants, sentFrom } = getThreadAddresses([
      message({ from: "alex@example.com", to: "me@example.com" }),
      message({ from: "alias@example.com", to: "stranger@example.com" }, [
        "DRAFT",
        "SENT",
      ]),
    ]);

    expect(participants).not.toContain("stranger@example.com");
    expect(sentFrom).not.toContain("alias@example.com");
  });

  it("reports the addresses the user has sent from in the thread", () => {
    const { sentFrom } = getThreadAddresses([
      message({ from: "alex@example.com", to: "alias@example.com" }),
      message({ from: "Me <alias@example.com>", to: "alex@example.com" }, [
        "SENT",
      ]),
    ]);

    expect(sentFrom).toBe("Me <alias@example.com>");
  });

  it("does not take a received message's sender for the user", () => {
    expect(
      getThreadAddresses([
        message({ from: "alex@example.com", to: "me@example.com" }),
      ]).sentFrom,
    ).toBe("");
  });
});
