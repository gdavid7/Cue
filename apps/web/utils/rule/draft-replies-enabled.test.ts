import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { getAction } from "@/__tests__/helpers";
import {
  canWriteRequestedReplies,
  getDraftRepliesSetting,
  withDefaultDraftReply,
} from "@/utils/rule/draft-replies-enabled";
import type { RuleWithActions } from "@/utils/types";

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

  // DR-5: mailboxes from before drafting was the default never chose, and
  // never choosing is on, so they get suggestions like a new mailbox.
  it.each([
    ["no To Reply rule", null],
    ["To Reply only labelling", { enabled: true, actions: [labels] }],
    ["To Reply with no actions", { enabled: true, actions: [] }],
  ])("is on with %s", (_case, rule) => {
    const setting = getDraftRepliesSetting(rule);

    expect(setting).toBe("on");
    expect(canWriteRequestedReplies(setting)).toBe(true);
  });

  it("is off everywhere when the deployment disables auto drafting", () => {
    mockEnv.autoDraftDisabled = true;

    expect(getDraftRepliesSetting({ enabled: true, actions: [drafts] })).toBe(
      "off",
    );
    expect(getDraftRepliesSetting(null)).toBe("off");
    expect(getDraftRepliesSetting({ enabled: true, actions: [] })).toBe("off");
  });
});

describe("withDefaultDraftReply", () => {
  beforeEach(() => {
    mockEnv.autoDraftDisabled = false;
  });

  it("gives a To Reply rule that never chose the draft it would have had", () => {
    const rule = toReply({ actions: [] });

    expect(actionTypes(withDefaultDraftReply(rule))).toEqual([
      ActionType.DRAFT_EMAIL,
    ]);
    // Only in memory: the saved rule is left as it is.
    expect(rule.actions).toEqual([]);
  });

  it("keeps a To Reply rule's own actions alongside the draft", () => {
    const rule = toReply({ actions: [getAction({ type: ActionType.LABEL })] });

    expect(actionTypes(withDefaultDraftReply(rule))).toEqual([
      ActionType.LABEL,
      ActionType.DRAFT_EMAIL,
    ]);
  });

  it("adds no second draft to a rule that already drafts", () => {
    const rule = toReply({
      actions: [getAction({ type: ActionType.DRAFT_EMAIL })],
    });

    expect(withDefaultDraftReply(rule)).toBe(rule);
  });

  it("leaves a To Reply rule the user turned off alone", () => {
    const rule = toReply({ enabled: false, actions: [] });

    expect(withDefaultDraftReply(rule)).toBe(rule);
  });

  it("leaves other rules alone", () => {
    const rule = toReply({ systemType: SystemType.FYI, actions: [] });

    expect(withDefaultDraftReply(rule)).toBe(rule);
  });

  it("adds nothing when the deployment disables auto drafting", () => {
    mockEnv.autoDraftDisabled = true;
    const rule = toReply({ actions: [] });

    expect(withDefaultDraftReply(rule)).toBe(rule);
  });
});

function toReply(overrides: Partial<RuleWithActions>): RuleWithActions {
  return {
    id: "rule-1",
    name: "To Reply",
    instructions: null,
    enabled: true,
    emailAccountId: "account-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    actions: [],
    runOnThreads: true,
    from: null,
    to: null,
    subject: null,
    body: null,
    groupId: null,
    conditionalOperator: "AND",
    systemType: SystemType.TO_REPLY,
    automate: true,
    promptText: null,
    categoryFilterType: null,
    ...overrides,
  } as RuleWithActions;
}

function actionTypes(rule: RuleWithActions) {
  return rule.actions.map((action) => action.type);
}
