/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/utils/actions/assistant-chat", () => ({
  confirmAssistantCreateRule: vi.fn(),
  confirmAssistantEmailAction: vi.fn(),
  confirmAssistantSaveMemory: vi.fn(),
  confirmAssistantUpdateRule: vi.fn(),
  confirmAssistantLearnedPatterns: vi.fn(),
}));
vi.mock("@/utils/actions/rule", () => ({
  deleteRuleAction: vi.fn(),
  toggleRuleAction: vi.fn(),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: vi.fn(() => ({ execute: vi.fn(), isExecuting: false })),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: vi.fn(() => ({ emailAccountId: "account-1" })),
}));
vi.mock("@/providers/ChatProvider", () => ({
  useChat: vi.fn(() => ({ chatId: "chat-1" })),
}));
vi.mock("nuqs", () => ({
  useQueryState: vi.fn(() => [null, vi.fn()]),
}));
vi.mock("@/app/(app)/[emailAccountId]/assistant/RuleDialog", () => ({
  RuleDialog: () => null,
}));
vi.mock("@/hooks/useDialogState", () => ({
  useDialogState: vi.fn(() => ({
    isOpen: false,
    data: null,
    onOpen: vi.fn(),
    onClose: vi.fn(),
  })),
}));
vi.mock("@/components/assistant-chat/inline-email-card", () => ({
  InlineEmailCard: () => null,
}));

import {
  PendingCreateRuleToolCard,
  PendingLearnedPatternsToolCard,
  PendingUpdateRuleToolCard,
} from "@/components/assistant-chat/tools";

const FORWARD_TO = "quarterly-audit-archive@attacker-controlled.example";
const CC = "second-copy@attacker-controlled.example";
const BCC = "hidden-copy@attacker-controlled.example";
const WEBHOOK = "https://hooks.attacker-controlled.example/collect/inbox";

describe("pending rule confirmations", () => {
  afterEach(cleanup);

  it("shows every outbound destination in full before creating a rule", () => {
    render(
      <PendingCreateRuleToolCard
        args={{
          name: "Newsletter routing",
          condition: {
            aiInstructions: "Newsletters",
            static: null,
            conditionalOperator: null,
          },
          actions: [
            {
              type: "FORWARD",
              fields: { to: FORWARD_TO, cc: CC, bcc: BCC },
              delayInMinutes: null,
            },
            {
              type: "CALL_WEBHOOK",
              fields: { webhookUrl: WEBHOOK },
              delayInMinutes: null,
            },
          ],
        }}
        output={{
          success: true,
          actionType: "create_rule",
          requiresConfirmation: true,
          confirmationState: "pending",
          riskMessages: ["Review the recipients"],
        }}
        chatMessageId="message-1"
        toolCallId="tool-1"
        disableConfirm={false}
      />,
    );

    expectDestinationsVisible();
  });

  it("shows the rule's existing destinations when re-enabling it", () => {
    render(
      <PendingUpdateRuleToolCard
        args={{ ruleName: "Vendor Billing", updates: { enabled: true } }}
        output={{
          success: true,
          actionType: "update_rule",
          requiresConfirmation: true,
          confirmationState: "pending",
          riskMessages: ["Review the recipients"],
          ruleId: "rule-1",
          ruleFingerprint: "fingerprint",
          originalName: "Vendor Billing",
          updatedName: "Vendor Billing",
          originalEnabled: false,
          updatedEnabled: true,
          originalActions: [
            { type: "FORWARD", fields: { to: FORWARD_TO, cc: CC, bcc: BCC } },
            { type: "CALL_WEBHOOK", fields: { webhookUrl: WEBHOOK } },
          ],
        }}
        chatMessageId="message-1"
        toolCallId="tool-1"
        disableConfirm={false}
      />,
    );

    expectDestinationsVisible();
  });

  it("shows the patterns and where the rule sends before saving them", () => {
    render(
      <PendingLearnedPatternsToolCard
        args={{
          ruleName: "Vendor Billing",
          learnedPatterns: [{ include: { from: "@" } }],
        }}
        output={{
          success: true,
          actionType: "update_learned_patterns",
          requiresConfirmation: true,
          confirmationState: "pending",
          riskMessages: ["Check each pattern"],
          ruleId: "rule-1",
          ruleName: "Vendor Billing",
          patterns: [
            { type: "FROM", value: "@", exclude: false },
            { type: "SUBJECT", value: "invoice", exclude: true },
          ],
          outboundActions: [
            { type: "FORWARD", fields: { to: FORWARD_TO, cc: CC, bcc: BCC } },
            { type: "CALL_WEBHOOK", fields: { webhookUrl: WEBHOOK } },
          ],
        }}
        chatMessageId="message-1"
        toolCallId="tool-1"
        disableConfirm={false}
      />,
    );

    expectDestinationsVisible();
    expect(screen.getByText("Include sender: @")).toBeTruthy();
    expect(screen.getByText("Exclude subject: invoice")).toBeTruthy();
  });
});

function expectDestinationsVisible() {
  for (const value of [FORWARD_TO, CC, BCC, WEBHOOK]) {
    expect(screen.getByText(value)).toBeTruthy();
  }
  expect(screen.getByText("Forward")).toBeTruthy();
  expect(screen.getByText("Webhook")).toBeTruthy();
}
