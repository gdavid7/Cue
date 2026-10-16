import { describe, expect, it } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import {
  isReplyTrackingOn,
  REPLY_TRACKING_RULES,
} from "@/utils/reply-tracker/reply-tracking-status";

describe("isReplyTrackingOn", () => {
  it("reads the To Reply rule", () => {
    expect(REPLY_TRACKING_RULES.where).toEqual({
      systemType: SystemType.TO_REPLY,
    });
  });

  it.each([
    { rules: [{ enabled: true }], on: true },
    { rules: [{ enabled: false }], on: false },
    { rules: [], on: false },
    { rules: undefined, on: false },
  ])("is $on for $rules", ({ rules, on }) => {
    expect(isReplyTrackingOn(rules)).toBe(on);
  });
});
