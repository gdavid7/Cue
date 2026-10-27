// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposeEmailForm } from "./ComposeEmailForm";

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({
    execute: vi.fn(),
    executeAsync: vi.fn(async () => ({})),
    isExecuting: false,
  }),
}));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_CONTACTS_ENABLED: false, NEXT_PUBLIC_BRAND_NAME: "Cue" },
}));
// The engine's storage gate needs OPFS, which jsdom lacks.
vi.mock("@/utils/mail-engine/MailEngineHost", () => ({
  MailCoverageGate: ({ children }: { children: React.ReactNode }) => children,
  useMailEngineDemand: () => {},
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccount: undefined,
    emailAccountId: "account-1",
    userEmail: "me@example.com",
    provider: "google",
  }),
}));
vi.mock("@/hooks/useEmailAccountFull", () => ({
  useEmailAccountFull: () => ({
    data: { id: "account-1", email: "me@example.com" },
    isLoading: false,
    error: undefined,
  }),
}));
vi.mock("@/hooks/useOwnEmailAddresses", () => ({
  useOwnEmailAddresses: () => ["me@example.com"],
}));
vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/utils/actions/mail", () => ({
  createDraftAction: vi.fn(),
  deleteDraftAction: vi.fn(),
  sendEmailAction: vi.fn(),
  updateDraftAction: vi.fn(),
}));
vi.mock("@/utils/actions/scheduled-email", () => ({
  scheduleEmailAction: vi.fn(),
}));
vi.mock("@/utils/actions/thread-assist", () => ({}));
vi.mock("@/utils/actions/compose-assist", () => ({
  recordComposeAssistOutcomeAction: vi.fn(),
}));

const BILLING = "billing@payments-desk.net";
const ANA = "Ana Ruiz <ana@supplier.com>";

afterEach(cleanup);

function renderReply(to: string) {
  render(
    <ComposeEmailForm
      draftKeyMessageId="msg-1"
      replyingToEmail={{
        threadId: "thread-1",
        messageId: "msg-1",
        subject: "Re: Invoice",
        to,
        replyToHeaders: { from: ANA, "reply-to": BILLING },
      }}
    />,
  );
}

describe("ComposeEmailForm Reply-To notice", () => {
  it("says the reply goes to the Reply-To and swaps it for the sender", async () => {
    renderReply(BILLING);

    expect(
      await screen.findByText(
        `Goes to ${BILLING}, set by the sender's Reply-To`,
      ),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Reply to Ana Ruiz instead" }),
    );

    expect(screen.queryByText(/set by the sender's Reply-To/)).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Reply to Ana Ruiz instead" }),
    ).toBeNull();
    // The collapsed recipients now name the sender, not the Reply-To.
    expect(
      screen.getByRole("button", { name: /to Ana/, expanded: false }),
    ).toBeTruthy();
  });

  it("stays quiet when the reply already goes to the sender", async () => {
    renderReply(ANA);

    await screen.findByRole("button", { name: /to Ana/, expanded: false });
    expect(screen.queryByText(/set by the sender's Reply-To/)).toBeNull();
  });
});
