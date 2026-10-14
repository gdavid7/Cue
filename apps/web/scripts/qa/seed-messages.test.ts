import { describe, expect, it } from "vitest";
import { extractSignInCode } from "./qa-mailbox";
import { buildSeedMessages } from "./seed-messages";

const EMAIL = "cue.qa.test@gmail.com";

describe("buildSeedMessages", () => {
  const messages = buildSeedMessages({
    email: EMAIL,
    now: new Date("2026-10-14T12:00:00Z"),
  });

  it("never addresses anyone outside the QA account and reserved domains", () => {
    const addresses = messages.flatMap((message) =>
      [message.mail.from, message.mail.to, message.mail.cc]
        .flat()
        .filter(Boolean)
        .map((entry) =>
          typeof entry === "string"
            ? entry
            : (entry as { address: string }).address,
        ),
    );

    expect(addresses.length).toBeGreaterThan(0);
    for (const address of addresses) {
      expect(address === EMAIL || address.endsWith("@example.com")).toBe(true);
    }
    const invite = messages.find((message) => message.mail.icalEvent);
    const ics = String(
      (invite?.mail.icalEvent as { content?: string } | undefined)?.content,
    );
    for (const mailto of ics.match(/mailto:[^\s\r\n]+/g) ?? []) {
      expect(
        mailto === `mailto:${EMAIL}` || mailto.endsWith("@example.com"),
      ).toBe(true);
    }
  });

  it("covers the mail the robot relies on", () => {
    const subjects = messages.map((message) => String(message.mail.subject));

    expect(messages.some((message) => message.mail.icalEvent)).toBe(true);
    expect(subjects).toContain("CSE 151B: milestone 2 due Friday at 11:59pm");
    const longThread = messages.filter((message) =>
      String(message.mail.subject).endsWith(
        "CSE 151B project: evaluation plan",
      ),
    );
    expect(longThread.length).toBeGreaterThanOrEqual(5);
    expect(longThread.at(-1)?.mail.references).toHaveLength(
      longThread.length - 1,
    );
    expect(messages.some((message) => message.folder === "sent")).toBe(true);
    expect(messages.some((message) => message.unread)).toBe(true);
  });

  it("gives every message a Message-ID that stays the same across runs", () => {
    const later = buildSeedMessages({
      email: EMAIL,
      now: new Date("2026-10-21T12:00:00Z"),
    });

    expect(new Set(messages.map((m) => m.messageId)).size).toBe(
      messages.length,
    );
    expect(later.map((m) => m.messageId)).toEqual(
      messages.map((m) => m.messageId),
    );
  });
});

describe("extractSignInCode", () => {
  it("reads the code from the plain-text and HTML sign-in email", () => {
    expect(
      extractSignInCode(
        "Your Cue sign-in code is 482913.\n\nThis code expires",
      ),
    ).toBe("482913");
    expect(
      extractSignInCode(
        "<p>Your Cue sign-in code is <strong>073518</strong>.</p>",
      ),
    ).toBe("073518");
  });

  it("ignores other six-digit numbers", () => {
    expect(extractSignInCode("Order 123456 shipped")).toBeNull();
  });
});
