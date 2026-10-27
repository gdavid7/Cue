// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposeEmailForm } from "./ComposeEmailForm";
import { getLatestSenderOffsets } from "./recipient-local-time";

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

const LESLIE = "leslie@example.com";
// Leslie is never in the test machine's zone, now or when she wrote.
const OWN_OFFSETS = [
  Date.UTC(2026, 9, 26, 0),
  Date.UTC(2026, 9, 26, 18, 12),
].map((ms) => -new Date(ms).getTimezoneOffset());
const LESLIE_OFFSET = OWN_OFFSETS.includes(540) ? 600 : 540;
const LESLIE_ZONE = LESLIE_OFFSET === 540 ? "+0900" : "+1000";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // 18:12 UTC is 03:12 or 04:12 for Leslie, before her day starts.
  vi.setSystemTime(new Date(Date.UTC(2026, 9, 26, 18, 12)));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("ComposeEmailForm recipient's local time", () => {
  it("shows the sender's time from the thread and fills Send later with their next 8:00", async () => {
    const thread = [
      {
        headers: {
          from: `Leslie Example <${LESLIE}>`,
          date: `Mon, 26 Oct 2026 09:00:00 ${LESLIE_ZONE}`,
        },
        labelIds: ["INBOX"],
      },
    ];
    render(
      <ComposeEmailForm
        draftKeyMessageId="msg-1"
        replyingToEmail={{
          threadId: "thread-1",
          messageId: "msg-1",
          subject: "Re: Plan",
          to: `Leslie Example <${LESLIE}>`,
          senderUtcOffsets: getLatestSenderOffsets(thread),
        }}
      />,
    );

    const line = await screen.findByText(/^(?!Send at).*their time$/);
    expect(line.textContent).toMatch(/^[34]:12 am their time$/);
    fireEvent.click(
      screen.getByRole("button", { name: "Send at 8:00 am their time" }),
    );

    expect(
      screen.queryByRole("button", { name: /^Send at .+ their time$/ }),
    ).toBeNull();
    expect(screen.getByText(/^(?!Send at).*their time$/)).toBeTruthy();
    // Their next 8:00 is 23:00 or 22:00 UTC on Oct 26.
    const nextMorning = new Date(
      Date.UTC(2026, 9, 26, 32 - LESLIE_OFFSET / 60),
    );
    expect(screen.getByRole("button", { name: "Send later" }).textContent).toBe(
      nextMorning.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      }),
    );
  });
});
