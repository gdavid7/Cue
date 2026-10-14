import { describe, expect, it } from "vitest";
import {
  parseDarkEmailMode,
  parseSenderModes,
  rememberSenderDarkEmailMode,
  resolveDarkEmailMode,
} from "@/utils/email/dark-email-preference";

describe("resolveDarkEmailMode", () => {
  it("uses a sender's remembered choice, matching the address case-insensitively", () => {
    expect(
      resolveDarkEmailMode({
        defaultMode: "adapt",
        senderModes: { "news@shop.com": "original" },
        sender: "News@Shop.com",
      }),
    ).toBe("original");
  });

  it("falls back to the default for other senders and unknown ones", () => {
    const senderModes = { "news@shop.com": "original" } as const;
    expect(
      resolveDarkEmailMode({
        defaultMode: "adapt",
        senderModes,
        sender: "hello@other.com",
      }),
    ).toBe("adapt");
    expect(
      resolveDarkEmailMode({
        defaultMode: "original",
        senderModes,
        sender: null,
      }),
    ).toBe("original");
  });
});

describe("rememberSenderDarkEmailMode", () => {
  it("stores a choice that differs from the default", () => {
    expect(
      rememberSenderDarkEmailMode(
        {},
        { sender: "News@Shop.com", mode: "original", defaultMode: "adapt" },
      ),
    ).toEqual({ "news@shop.com": "original" });
  });

  it("forgets a choice that matches the default, so the sender follows later default changes", () => {
    const remembered = rememberSenderDarkEmailMode(
      { "news@shop.com": "original" },
      { sender: "news@shop.com", mode: "adapt", defaultMode: "adapt" },
    );
    expect(remembered).toEqual({});
    expect(
      resolveDarkEmailMode({
        defaultMode: "original",
        senderModes: remembered,
        sender: "news@shop.com",
      }),
    ).toBe("original");
  });

  it("keeps only the most recent senders", () => {
    let senderModes = {};
    for (let index = 0; index < 510; index += 1) {
      senderModes = rememberSenderDarkEmailMode(senderModes, {
        sender: `sender${index}@example.com`,
        mode: "original",
        defaultMode: "adapt",
      });
    }
    expect(Object.keys(senderModes)).toHaveLength(500);
    expect(senderModes).not.toHaveProperty(["sender0@example.com"]);
    expect(senderModes).toHaveProperty(["sender509@example.com"]);
  });
});

describe("stored values", () => {
  it("treats missing or corrupted storage as the defaults", () => {
    expect(parseDarkEmailMode(null)).toBe("adapt");
    expect(parseDarkEmailMode("sepia")).toBe("adapt");
    expect(parseDarkEmailMode("original")).toBe("original");
    expect(parseSenderModes("{not json")).toEqual({});
    expect(parseSenderModes('{"a@b.com":"sepia"}')).toEqual({});
    expect(parseSenderModes('{"a@b.com":"original"}')).toEqual({
      "a@b.com": "original",
    });
  });
});
