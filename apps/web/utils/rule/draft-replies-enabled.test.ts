import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  canWriteRequestedReplies,
  getDraftRepliesSetting,
} from "@/utils/rule/draft-replies-enabled";

const mockEnv = vi.hoisted(() => ({ autoDraftDisabled: false }));

vi.mock("@/env", () => ({
  env: {
    get NEXT_PUBLIC_AUTO_DRAFT_DISABLED() {
      return mockEnv.autoDraftDisabled;
    },
  },
}));

const drafts = { type: ActionType.DRAFT_EMAIL };
const labels = { type: ActionType.LABEL };

describe("getDraftRepliesSetting", () => {
  beforeEach(() => {
    mockEnv.autoDraftDisabled = false;
  });

  it("is on when To Reply is enabled and drafts", () => {
    expect(
      getDraftRepliesSetting({ enabled: true, actions: [labels, drafts] }),
    ).toBe("on");
  });

  // The settings toggle turns the whole To Reply rule off, so a disabled
  // rule is the user's no, and nothing may write a reply for them.
  it("is off once the user turned To Reply off", () => {
    const setting = getDraftRepliesSetting({ enabled: false, actions: [] });

    expect(setting).toBe("off");
    expect(canWriteRequestedReplies(setting)).toBe(false);
  });

  // Mailboxes from before drafting was the default: never asked, so a reply
  // the user asks for is still allowed, but nothing drafts unasked.
  it.each([
    ["no To Reply rule", null],
    ["To Reply only labelling", { enabled: true, actions: [labels] }],
    ["To Reply with no actions", { enabled: true, actions: [] }],
  ])("is unset with %s", (_case, rule) => {
    const setting = getDraftRepliesSetting(rule);

    expect(setting).toBe("unset");
    expect(canWriteRequestedReplies(setting)).toBe(true);
  });

  it("is off everywhere when the deployment disables auto drafting", () => {
    mockEnv.autoDraftDisabled = true;

    expect(getDraftRepliesSetting({ enabled: true, actions: [drafts] })).toBe(
      "off",
    );
    expect(getDraftRepliesSetting(null)).toBe("off");
  });
});
