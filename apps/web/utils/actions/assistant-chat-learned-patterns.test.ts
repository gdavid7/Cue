import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";

const { saveLearnedPatternsMock } = vi.hoisted(() => ({
  saveLearnedPatternsMock: vi.fn(),
}));

vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPatterns: saveLearnedPatternsMock,
}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@example.com" } })),
}));

import prisma from "@/utils/__mocks__/prisma";
import { confirmAssistantLearnedPatterns } from "@/utils/actions/assistant-chat";
import { confirmAssistantLearnedPatternsForAccount } from "@/utils/actions/assistant-chat-confirmation";
import { getRuleFingerprint } from "@/utils/ai/assistant/tools/rules/update-rule-tool";

const STORED_RULE = {
  id: "rule-1",
  name: "Forward receipts",
  organizationRuleId: null,
  enabled: true,
  instructions: "Receipts",
  from: null,
  to: null,
  subject: null,
  conditionalOperator: "AND",
  actions: [
    {
      type: "FORWARD",
      content: null,
      label: null,
      to: "accountant@example.com",
      cc: null,
      bcc: null,
      subject: null,
      url: null,
      folderName: null,
      delayInMinutes: null,
    },
  ],
};

const PATTERNS = [
  { type: "FROM", value: "boss@company.example", exclude: false },
  { type: "FROM", value: "noreply@shop.example", exclude: true },
];

describe("confirmAssistantLearnedPatterns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.chatMessage.updateMany.mockResolvedValue({ count: 1 } as never);
    prisma.rule.findUnique.mockResolvedValue(STORED_RULE as never);
    saveLearnedPatternsMock.mockResolvedValue({});
  });

  it("saves exactly the patterns shown, for the account's own rule", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValueOnce({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });
    mockStoredMessage(buildPendingPart());

    const result = await confirmAssistantLearnedPatterns(
      "ea_1" as never,
      {
        chatId: "chat-1",
        chatMessageId: "cm-1",
        toolCallId: "tool-lp-1",
      } as never,
    );

    expect(result?.data?.confirmationState).toBe("confirmed");
    expect(prisma.rule.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rule-1", emailAccountId: "ea_1" },
      }),
    );
    expect(saveLearnedPatternsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "ea_1",
        ruleName: "Forward receipts",
        patterns: PATTERNS,
      }),
    );
    const updatedParts = (
      prisma.chatMessage.updateMany.mock.calls[1][0] as {
        data: { parts: { output: Record<string, unknown> }[] };
      }
    ).data.parts;
    expect(updatedParts[0].output.confirmationState).toBe("confirmed");
  });

  it("refuses when the rule's destination changed after the patterns were proposed", async () => {
    mockStoredMessage(buildPendingPart());
    prisma.rule.findUnique.mockResolvedValue({
      ...STORED_RULE,
      actions: [{ ...STORED_RULE.actions[0], to: "someone-else@example.com" }],
    } as never);

    await expect(
      confirmAssistantLearnedPatternsForAccount({
        chatId: "chat-1",
        chatMessageId: "cm-1",
        toolCallId: "tool-lp-1",
        emailAccountId: "ea_1",
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("changed");
    expect(saveLearnedPatternsMock).not.toHaveBeenCalled();
  });

  it("refuses a rule that does not belong to the confirming account", async () => {
    mockStoredMessage(buildPendingPart());
    prisma.rule.findUnique.mockResolvedValue(null as never);

    await expect(
      confirmAssistantLearnedPatternsForAccount({
        chatId: "chat-1",
        chatMessageId: "cm-1",
        toolCallId: "tool-lp-1",
        emailAccountId: "ea_1",
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("Rule not found");
    expect(saveLearnedPatternsMock).not.toHaveBeenCalled();
  });
});

function mockStoredMessage(part: Record<string, unknown>) {
  prisma.chatMessage.findFirst.mockResolvedValue({
    id: "cm-1",
    chatId: "chat-1",
    updatedAt: new Date("2026-04-27T00:01:00.000Z"),
    parts: [part],
  } as never);
}

function buildPendingPart() {
  return {
    type: "tool-updateLearnedPatterns",
    toolCallId: "tool-lp-1",
    state: "output-available",
    input: {
      ruleName: "Forward receipts",
      learnedPatterns: [{ include: { from: "something-else@example.com" } }],
    },
    output: {
      success: true,
      actionType: "update_learned_patterns",
      requiresConfirmation: true,
      confirmationState: "pending",
      riskMessages: ["This rule forwards mail."],
      ruleId: "rule-1",
      ruleName: "Forward receipts",
      ruleFingerprint: getRuleFingerprint(STORED_RULE as never),
      patterns: PATTERNS,
      outboundActions: [
        { type: "FORWARD", fields: { to: "accountant@example.com" } },
      ],
    },
  };
}
