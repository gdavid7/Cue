import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import { createTestLogger } from "@/__tests__/helpers";

const { partialUpdateRuleMock, updateRuleActionsMock, setRuleEnabledMock } =
  vi.hoisted(() => ({
    partialUpdateRuleMock: vi.fn(),
    updateRuleActionsMock: vi.fn(),
    setRuleEnabledMock: vi.fn(),
  }));

vi.mock("@/utils/rule/rule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rule/rule")>();
  return {
    ...actual,
    partialUpdateRule: partialUpdateRuleMock,
    updateRuleActions: updateRuleActionsMock,
    setRuleEnabled: setRuleEnabledMock,
  };
});

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@example.com" } })),
}));

import prisma from "@/utils/__mocks__/prisma";
import { confirmAssistantUpdateRule } from "@/utils/actions/assistant-chat";
import { confirmAssistantUpdateRuleForAccount } from "@/utils/actions/assistant-chat-confirmation";
import { getRuleFingerprint } from "@/utils/ai/assistant/tools/rules/update-rule-tool";

const STORED_RULE = {
  id: "rule-id",
  name: "Newsletter",
  enabled: true,
  updatedAt: new Date("2026-04-27T00:00:00.000Z"),
  organizationRuleId: null,
  instructions: "Newsletters",
  from: null,
  to: null,
  subject: null,
  conditionalOperator: "AND",
  actions: [
    {
      type: ActionType.LABEL,
      content: null,
      label: "Newsletter",
      to: null,
      cc: null,
      bcc: null,
      subject: null,
      url: null,
      folderName: null,
      delayInMinutes: null,
    },
  ],
};

describe("confirmAssistantUpdateRule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.rule.findUnique.mockResolvedValue(STORED_RULE as never);
  });

  it("applies exactly the pending update shown to the user", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });
    mockStoredMessage(buildPendingUpdateRulePart());

    const result = await confirmAssistantUpdateRule(
      "ea_1" as never,
      {
        chatId: "chat-1",
        chatMessageId: "cm-1",
        toolCallId: "tool-ur-1",
      } as never,
    );

    expect(result?.data?.confirmationState).toBe("confirmed");
    expect(prisma.rule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rule-id", emailAccountId: "ea_1" },
      }),
    );
    expect(partialUpdateRuleMock).toHaveBeenCalledWith({
      ruleId: "rule-id",
      emailAccountId: "ea_1",
      data: { name: "Newsletter forwarding" },
    });
    expect(updateRuleActionsMock).toHaveBeenCalledTimes(1);
    expect(updateRuleActionsMock.mock.calls[0][0]).toMatchObject({
      ruleId: "rule-id",
      emailAccountId: "ea_1",
      actions: [
        { type: ActionType.LABEL, fields: { label: "Newsletter" } },
        { type: ActionType.FORWARD, fields: { to: "audit@attacker.example" } },
      ],
    });
    expect(setRuleEnabledMock).not.toHaveBeenCalled();

    const updatedParts = (
      prisma.chatMessage.updateMany.mock.calls[1][0] as {
        data: { parts: { output: Record<string, unknown> }[] };
      }
    ).data.parts;
    expect(updatedParts[0].output.confirmationState).toBe("confirmed");
  });

  it("refuses a rule that does not belong to the confirming account", async () => {
    mockStoredMessage(buildPendingUpdateRulePart());
    prisma.rule.findUnique.mockResolvedValue(null as never);

    await expect(confirmForAccount()).rejects.toThrow("Rule not found");

    expect(partialUpdateRuleMock).not.toHaveBeenCalled();
    expect(updateRuleActionsMock).not.toHaveBeenCalled();
  });

  it("refuses when the rule changed after the update was proposed", async () => {
    mockStoredMessage(buildPendingUpdateRulePart());
    prisma.rule.findUnique.mockResolvedValue({
      ...STORED_RULE,
      instructions: "Every newsletter and every receipt",
    } as never);

    await expect(confirmForAccount()).rejects.toThrow("changed");

    expect(partialUpdateRuleMock).not.toHaveBeenCalled();
    expect(updateRuleActionsMock).not.toHaveBeenCalled();
  });

  it("refuses when the rule was toggled from the Rules page while pending", async () => {
    mockStoredMessage(buildPendingUpdateRulePart());
    prisma.rule.findUnique.mockResolvedValue({
      ...STORED_RULE,
      enabled: false,
    } as never);

    await expect(confirmForAccount()).rejects.toThrow(
      "This rule changed after the assistant proposed this update",
    );
    expect(partialUpdateRuleMock).not.toHaveBeenCalled();
    expect(updateRuleActionsMock).not.toHaveBeenCalled();
    expect(setRuleEnabledMock).not.toHaveBeenCalled();
  });

  it("refuses when only the rule's actions changed, even with the same updatedAt", async () => {
    mockStoredMessage(buildPendingUpdateRulePart());
    prisma.rule.findUnique.mockResolvedValue({
      ...STORED_RULE,
      actions: [
        ...STORED_RULE.actions,
        { ...STORED_RULE.actions[0], type: ActionType.ARCHIVE, label: null },
      ],
    } as never);

    await expect(confirmForAccount()).rejects.toThrow("changed");

    expect(updateRuleActionsMock).not.toHaveBeenCalled();
  });

  it("returns the confirmed state without writing again", async () => {
    mockStoredMessage(
      buildPendingUpdateRulePart({
        confirmationState: "confirmed",
        confirmationResult: {
          ruleId: "rule-id",
          confirmedAt: "2026-04-27T00:05:00.000Z",
        },
      }),
    );

    const result = await confirmForAccount();

    expect(result.confirmationState).toBe("confirmed");
    expect(updateRuleActionsMock).not.toHaveBeenCalled();
  });
});

function confirmForAccount() {
  return confirmAssistantUpdateRuleForAccount({
    chatId: "chat-1",
    chatMessageId: "cm-1",
    toolCallId: "tool-ur-1",
    emailAccountId: "ea_1",
    provider: "google",
    logger: createTestLogger(),
  });
}

function mockStoredMessage(part: Record<string, unknown>) {
  prisma.chatMessage.findFirst.mockResolvedValue({
    id: "cm-1",
    chatId: "chat-1",
    updatedAt: new Date("2026-04-27T00:01:00.000Z"),
    parts: [part],
  } as never);
}

function buildPendingUpdateRulePart(output: Record<string, unknown> = {}) {
  return {
    type: "tool-updateRule",
    toolCallId: "tool-ur-1",
    state: "output-available",
    input: {
      ruleName: "Newsletter",
      updates: { name: "Something the card never showed" },
    },
    output: {
      success: true,
      actionType: "update_rule",
      requiresConfirmation: true,
      confirmationState: "pending",
      riskMessages: ["This change makes the rule send or forward email."],
      ruleId: "rule-id",
      ruleFingerprint: getRuleFingerprint(STORED_RULE as never),
      originalName: "Newsletter",
      updatedName: "Newsletter forwarding",
      originalEnabled: true,
      updatedEnabled: true,
      originalActions: [
        { type: ActionType.LABEL, fields: { label: "Newsletter" } },
      ],
      updatedActions: [
        {
          type: ActionType.LABEL,
          fields: { label: "Newsletter" },
          delayInMinutes: null,
        },
        {
          type: ActionType.FORWARD,
          fields: { to: "audit@attacker.example" },
          delayInMinutes: null,
        },
      ],
      ...output,
    },
  };
}
