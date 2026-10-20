import { describe, expect, it, vi } from "vitest";
import { getReaderReplyGate } from "@/app/(app)/[emailAccountId]/mail/reader-reply-gate";
import { getDraftRepliesSetting } from "@/utils/rule/draft-replies-enabled";

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

  // DR-5: a mailbox that never chose (To Reply on, no draft action) drafts
  // unasked like one that turned drafting on.
  it("drafts unasked for a mailbox that never chose", () => {
    const setting = getDraftRepliesSetting({ enabled: true, actions: [] });

    expect(getReaderReplyGate({ ...incoming, setting })).toEqual({
      canRequest: true,
      writesReplies: true,
      autoEligible: true,
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
      setting: "on",
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
