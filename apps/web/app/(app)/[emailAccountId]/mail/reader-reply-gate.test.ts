import { describe, expect, it, vi } from "vitest";
import { getReaderReplyGate } from "@/app/(app)/[emailAccountId]/mail/reader-reply-gate";

vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_AUTO_DRAFT_DISABLED: false } }));

const incoming = {
  settingLoading: false,
  hasLatest: true,
  latestIsFromUser: false,
  hasDraft: false,
};

describe("getReaderReplyGate", () => {
  it("drafts unasked only with Auto draft replies on", () => {
    expect(getReaderReplyGate({ ...incoming, setting: "on" })).toEqual({
      canRequest: true,
      writesReplies: true,
      autoEligible: true,
    });
  });

  // The founder-reported gap: a mailbox that never turned drafting on must
  // still get a working "Draft a reply", without drafting on its own.
  it("lets a mailbox that never chose ask for a draft", () => {
    expect(getReaderReplyGate({ ...incoming, setting: "unset" })).toEqual({
      canRequest: true,
      writesReplies: true,
      autoEligible: false,
    });
  });

  it("writes no reply at all once the user turned drafting off", () => {
    const gate = getReaderReplyGate({ ...incoming, setting: "off" });

    expect(gate.writesReplies).toBe(false);
    expect(gate.autoEligible).toBe(false);
  });

  it("waits for the setting before drafting unasked", () => {
    const gate = getReaderReplyGate({
      ...incoming,
      setting: "unset",
      settingLoading: true,
    });

    expect(gate.autoEligible).toBe(false);
    expect(gate.writesReplies).toBe(true);
  });

  it.each([
    ["the user wrote the newest message", { latestIsFromUser: true }],
    ["a draft already exists", { hasDraft: true }],
    ["there is no message", { hasLatest: false }],
  ])("offers nothing when %s", (_case, override) => {
    const gate = getReaderReplyGate({
      ...incoming,
      ...override,
      setting: "on",
    });

    expect(gate.canRequest).toBe(false);
    expect(gate.autoEligible).toBe(false);
  });
});
