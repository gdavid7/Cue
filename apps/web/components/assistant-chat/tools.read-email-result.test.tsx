/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAccount } from "@/providers/EmailAccountProvider";

vi.mock("@/utils/actions/assistant-chat", () => ({
  confirmAssistantCreateRule: vi.fn(),
  confirmAssistantEmailAction: vi.fn(),
  confirmAssistantSaveMemory: vi.fn(),
}));
vi.mock("@/utils/actions/rule", () => ({
  deleteRuleAction: vi.fn(),
  toggleRuleAction: vi.fn(),
}));
vi.mock("next-safe-action/hooks", () => ({
  useAction: vi.fn(),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: vi.fn(),
}));
vi.mock("@/providers/ChatProvider", () => ({
  useChat: vi.fn(),
}));
vi.mock("nuqs", () => ({
  useQueryState: vi.fn(),
}));
vi.mock("@/app/(app)/[emailAccountId]/assistant/RuleDialog", () => ({
  RuleDialog: () => null,
}));
vi.mock("@/hooks/useDialogState", () => ({
  useDialogState: vi.fn(),
}));
vi.mock("@/components/assistant-chat/inline-email-card", () => ({
  InlineEmailCard: () => null,
}));

import { ReadEmailResult } from "@/components/assistant-chat/tools";

describe("ReadEmailResult", () => {
  afterEach(cleanup);

  beforeEach(() => {
    vi.mocked(useAccount).mockReturnValue({
      provider: "google",
      userEmail: "me@example.com",
    } as never);
  });

  it("names the link after the provider of the account the email is in", () => {
    render(
      <ReadEmailResult
        output={{
          messageId: "acct:account-3:outlook-msg",
          threadId: "acct:account-3:outlook-thread",
          externalUrl: "https://outlook.office.com/mail/deeplink/read/msg",
          subject: "Contract renewal",
          account: "three@example.com",
          provider: "microsoft",
        }}
      />,
    );
    fireEvent.click(screen.getByText("Read Email"));

    expect(screen.getByText("Open in Outlook")).toBeTruthy();
    expect(screen.queryByText("Open in Gmail")).toBeNull();
  });

  it("names the link after the chat's provider for the chat's own email", () => {
    render(
      <ReadEmailResult
        output={{
          messageId: "msg",
          threadId: "thread",
          subject: "Contract renewal",
        }}
      />,
    );
    fireEvent.click(screen.getByText("Read Email"));

    expect(screen.getByText("Open in Gmail")).toBeTruthy();
  });
});
