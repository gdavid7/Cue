import { describe, expect, it, vi } from "vitest";
import { type ActionType, SystemType } from "@/generated/prisma/enums";
import { getDraftRepliesSetting } from "@/utils/rule/draft-replies-enabled";

const mockEnv = vi.hoisted(() => ({ autoDraftDisabled: false }));

vi.mock("@/env", () => ({
  env: {
    get NEXT_PUBLIC_AUTO_DRAFT_DISABLED() {
      return mockEnv.autoDraftDisabled;
    },
  },
}));

describe("INITIAL_REPLY_TRACKING_RULES", () => {
  it("starts new mailboxes with Auto draft replies on", async () => {
    const rules = await loadInitialRules(false);
    const toReply = rules.find((r) => r.systemType === SystemType.TO_REPLY);

    expect(getDraftRepliesSetting(asSavedRule(toReply))).toBe("on");
  });

  it("drafts only on To Reply, never labelling or moving mail", async () => {
    const rules = await loadInitialRules(false);

    for (const rule of rules) {
      const types = asSavedRule(rule).actions.map((a) => a.type);
      expect(types).toEqual(
        rule.systemType === SystemType.TO_REPLY ? ["DRAFT_EMAIL"] : [],
      );
    }
  });

  it("seeds no draft when the deployment disables auto drafting", async () => {
    const rules = await loadInitialRules(true);

    for (const rule of rules) {
      expect(asSavedRule(rule).actions).toEqual([]);
    }
  });
});

async function loadInitialRules(autoDraftDisabled: boolean) {
  mockEnv.autoDraftDisabled = autoDraftDisabled;
  vi.resetModules();
  const { INITIAL_REPLY_TRACKING_RULES } = await import(
    "@/utils/reply-tracker/initial-rules"
  );
  return INITIAL_REPLY_TRACKING_RULES;
}

// The rule as Prisma would store it from the nested create.
function asSavedRule(
  rule:
    | {
        enabled: boolean;
        actions?: { create: { type: ActionType }[] };
      }
    | undefined,
) {
  return {
    enabled: rule?.enabled ?? false,
    actions: rule?.actions?.create ?? [],
  };
}
