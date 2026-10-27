/** @vitest-environment jsdom */

import React, { createElement, type MouseEvent, type ReactNode } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InlineEmailCard,
  InlineEmailList,
} from "@/components/assistant-chat/inline-email-card";
import { getEmailUrlForMessage } from "@/utils/url";
import { toOtherAccountEmailId } from "@/utils/ai/assistant/other-account-email-id";

(globalThis as { React?: typeof React }).React = React;

const mockUseAccount = vi.fn();
const mockUseEmailLookup = vi.fn();
const mockArchiveThreadAction = vi.fn();
const mockMarkReadThreadAction = vi.fn();
const mockUseThread = vi.fn();
const mockQueueAction = vi.fn();

const mockUseAccounts = vi.fn();
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => mockUseAccounts(),
}));

// The scope provider makes descendants act as the account it is given.
vi.mock("@/providers/EmailAccountProvider", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  type Scoped = { id: string; email: string; account: { provider: string } };
  const Scope = React.createContext<Scoped | null>(null);
  return {
    useAccount: () => {
      const scoped = React.useContext(Scope);
      return scoped
        ? {
            emailAccountId: scoped.id,
            provider: scoped.account.provider,
            userEmail: scoped.email,
          }
        : mockUseAccount();
    },
    EmailAccountScopeProvider: ({
      children,
      emailAccount,
    }: {
      children: ReactNode;
      emailAccount?: Scoped;
    }) =>
      React.createElement(
        Scope.Provider,
        { value: emailAccount ?? null },
        children,
      ),
  };
});

vi.mock("@/components/assistant-chat/email-lookup-context", () => ({
  useEmailLookup: () => mockUseEmailLookup(),
}));

vi.mock("@/components/assistant-chat/inline-email-action-context", () => ({
  useInlineEmailActionContext: () => ({
    queueAction: (...args: unknown[]) => mockQueueAction(...args),
  }),
}));

vi.mock("@/utils/actions/mail", () => ({
  archiveThreadAction: (...args: unknown[]) => mockArchiveThreadAction(...args),
  markReadThreadAction: (...args: unknown[]) =>
    mockMarkReadThreadAction(...args),
}));

vi.mock("@/components/Toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: (event: MouseEvent<HTMLButtonElement>) => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      { type: "button", onClick, disabled },
      children || "icon-button",
    ),
}));

vi.mock("@/hooks/useThread", () => ({
  useThread: (...args: unknown[]) => mockUseThread(...args),
}));

vi.mock("@/components/email-list/EmailDetails", () => ({
  EmailDetails: ({
    message,
  }: {
    message: { headers?: { from?: string; to?: string } };
  }) => (
    <div>
      {message.headers?.from ? (
        <>
          <span>From:</span>
          <span>{message.headers.from}</span>
        </>
      ) : null}
      {message.headers?.to ? (
        <>
          <span>To:</span>
          <span>{message.headers.to}</span>
        </>
      ) : null}
    </div>
  ),
}));

vi.mock("@/components/email-list/EmailContents", () => ({
  HtmlEmail: ({ html }: { html: string }) => (
    <iframe title="Email content preview" srcDoc={html} />
  ),
  PlainEmail: ({ text }: { text: string }) => <pre>{text}</pre>,
}));

vi.mock("@/components/email-list/EmailAttachments", () => ({
  EmailAttachments: () => <div>Attachments</div>,
}));

afterEach(() => {
  cleanup();
});

describe("InlineEmailCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAccount.mockReturnValue({
      emailAccountId: "account-1",
      provider: "google",
      userEmail: "user@example.com",
    });

    mockUseEmailLookup.mockReturnValue(
      new Map([
        [
          "19cdca06580b38e9",
          {
            messageId: "msg-1",
            from: "Sender One",
            subject: "Subject One",
            snippet: "Snippet One",
            date: "2026-03-11T10:00:00.000Z",
            isUnread: true,
          },
        ],
        [
          "thread-1",
          {
            messageId: "msg-thread-1",
            from: "Sender Two",
            subject: "Subject Two",
            snippet: "Snippet Two",
            date: "2026-03-11T11:00:00.000Z",
            isUnread: false,
          },
        ],
        [
          "outlook-thread-1",
          {
            messageId: "outlook-message-1",
            from: "Outlook Sender",
            subject: "Outlook Subject",
            snippet: "Outlook Snippet",
            date: "2026-03-11T12:30:00.000Z",
            isUnread: false,
            externalUrl:
              "https://outlook.office.com/mail/deeplink/read/outlook-message-1?ispopout=0",
          },
        ],
        [
          "thread-2",
          {
            messageId: "msg-thread-2",
            from: "Sender Three",
            subject: "Subject Three",
            snippet: "Snippet Three",
            date: "2026-03-11T12:00:00.000Z",
            isUnread: false,
          },
        ],
      ]),
    );

    mockArchiveThreadAction.mockResolvedValue({});
    mockMarkReadThreadAction.mockResolvedValue({});
    mockQueueAction.mockReset();
    mockUseThread.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  it("normalizes legacy prefixed ids for the email link and archive action", async () => {
    render(
      createElement(
        InlineEmailCard,
        { id: "user-content-19cdca06580b38e9", action: "archive" },
        "Follow up",
      ),
    );

    openMoreActions();

    expect(
      screen
        .getByRole("menuitem", { name: "Open in email" })
        .getAttribute("href"),
    ).toBe(
      getEmailUrlForMessage(
        "msg-1",
        "19cdca06580b38e9",
        "user@example.com",
        "google",
      ),
    );

    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    await waitFor(() => {
      expect(mockArchiveThreadAction).toHaveBeenCalledWith("account-1", {
        threadId: "19cdca06580b38e9",
      });
    });

    expect(mockQueueAction).toHaveBeenCalledWith("archive_threads", [
      "19cdca06580b38e9",
    ]);
  });

  it("uses the provider URL for Outlook open-in-email links", () => {
    mockUseAccount.mockReturnValue({
      emailAccountId: "account-1",
      provider: "microsoft",
      userEmail: "user@example.com",
    });

    render(
      <InlineEmailCard threadid="outlook-thread-1" action="none">
        Outlook message
      </InlineEmailCard>,
    );

    openMoreActions();

    expect(
      screen
        .getByRole("menuitem", { name: "Open in email" })
        .getAttribute("href"),
    ).toBe(
      "https://outlook.office.com/mail/deeplink/read/outlook-message-1?ispopout=0",
    );
  });

  it("does not show an Outlook open-in-email link without a provider URL", () => {
    mockUseAccount.mockReturnValue({
      emailAccountId: "account-1",
      provider: "microsoft",
      userEmail: "user@example.com",
    });

    render(
      <InlineEmailCard threadid="thread-1" action="none">
        Outlook message
      </InlineEmailCard>,
    );

    openMoreActions();

    expect(
      screen.queryByRole("menuitem", { name: "Open in email" }),
    ).toBeNull();
  });

  it("renders the app email preview details from the menu", async () => {
    mockUseThread.mockReturnValue({
      data: {
        thread: {
          id: "thread-1",
          messages: [
            {
              id: "message-1",
              threadId: "thread-1",
              subject: "Rendered Subject",
              snippet: "Rendered snippet",
              date: "2026-03-11T11:00:00.000Z",
              historyId: "history-1",
              inline: [],
              headers: {
                from: "Sender Two <sender-two@example.com>",
                to: "user@example.com",
                date: "2026-03-11T11:00:00.000Z",
                subject: "Rendered Subject",
              },
              textPlain: "Rendered plain body",
            },
          ],
        },
      },
      isLoading: false,
      error: null,
    });

    render(
      <InlineEmailCard threadid="thread-1" action="none">
        Second
      </InlineEmailCard>,
    );

    openMoreActions();
    fireEvent.click(await screen.findByText("Show details"));

    expect(screen.getByText("From:")).toBeTruthy();
    expect(
      screen.getByText("Sender Two <sender-two@example.com>"),
    ).toBeTruthy();
    expect(screen.getByText("Rendered plain body")).toBeTruthy();
  });

  it("shows the archive action even when action is none", async () => {
    render(
      <InlineEmailCard threadid="thread-1" action="none">
        Second
      </InlineEmailCard>,
    );

    openMoreActions();

    expect(screen.getByRole("menuitem", { name: "Archive" })).toBeTruthy();
  });

  it("renders the preview when message headers are missing", () => {
    mockUseThread.mockReturnValue({
      data: {
        thread: {
          id: "thread-1",
          messages: [
            {
              id: "message-1",
              threadId: "thread-1",
              subject: "Fallback Subject",
              snippet: "Fallback snippet",
              date: "2026-03-11T11:00:00.000Z",
              historyId: "history-1",
              inline: [],
              textPlain: "Fallback body",
            },
          ],
        },
      },
      isLoading: false,
      error: null,
    });

    render(
      <InlineEmailCard threadid="thread-1" action="none">
        Second
      </InlineEmailCard>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Second/ }));

    expect(screen.getByText("Fallback body")).toBeTruthy();
  });
});

describe("InlineEmailList", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockUseAccount.mockReturnValue({
      emailAccountId: "account-1",
      provider: "google",
      userEmail: "user@example.com",
    });

    mockUseEmailLookup.mockReturnValue(new Map());
    mockArchiveThreadAction.mockResolvedValue({});
    mockMarkReadThreadAction.mockResolvedValue({});
    mockQueueAction.mockReset();
    mockUseThread.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  it("archives all cards using the dedicated threadid attribute", async () => {
    render(
      createElement(
        InlineEmailList,
        null,
        createElement(
          InlineEmailCard,
          { threadid: "thread-1", action: "none" },
          "First",
        ),
        createElement(
          InlineEmailCard,
          { threadid: "thread-2", action: "none" },
          "Second",
        ),
      ),
    );

    fireEvent.click(screen.getAllByRole("button")[0]);

    await waitFor(() => {
      expect(mockArchiveThreadAction).toHaveBeenCalledTimes(2);
    });

    expect(mockArchiveThreadAction).toHaveBeenNthCalledWith(1, "account-1", {
      threadId: "thread-1",
    });
    expect(mockArchiveThreadAction).toHaveBeenNthCalledWith(2, "account-1", {
      threadId: "thread-2",
    });
    expect(mockQueueAction).toHaveBeenCalledWith("archive_threads", [
      "thread-1",
      "thread-2",
    ]);
  });

  it("disables archive all after archive all succeeds", async () => {
    vi.useFakeTimers();

    try {
      render(
        <InlineEmailList>
          <InlineEmailCard threadid="thread-1">First</InlineEmailCard>
          <InlineEmailCard threadid="thread-2">Second</InlineEmailCard>
        </InlineEmailList>,
      );

      const archiveAllButton = screen.getAllByRole("button")[0];

      fireEvent.click(archiveAllButton);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect((archiveAllButton as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses fully archived sections into a compact summary", async () => {
    vi.useFakeTimers();

    try {
      render(
        <InlineEmailList>
          <InlineEmailCard threadid="thread-1">First</InlineEmailCard>
          <InlineEmailCard threadid="thread-2">Second</InlineEmailCard>
        </InlineEmailList>,
      );

      fireEvent.click(screen.getAllByRole("button")[0]);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockQueueAction).toHaveBeenCalledWith("archive_threads", [
        "thread-1",
        "thread-2",
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(screen.getByText("Completed emails")).toBeTruthy();
      expect(screen.getByText("2 archived")).toBeTruthy();
      expect(screen.queryByText("First")).toBeNull();
      expect(screen.queryByText("Second")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("collapses fully marked-read sections into a compact summary", async () => {
    vi.useFakeTimers();

    try {
      render(
        <InlineEmailList>
          <InlineEmailCard threadid="thread-1">First</InlineEmailCard>
          <InlineEmailCard threadid="thread-2">Second</InlineEmailCard>
        </InlineEmailList>,
      );

      fireEvent.click(screen.getAllByRole("button")[1]);

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockQueueAction).toHaveBeenCalledWith("mark_read_threads", [
        "thread-1",
        "thread-2",
      ]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(screen.getByText("Completed emails")).toBeTruthy();
      expect(screen.getByText("2 marked read")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("archives each email in its own account with archive all", async () => {
    const otherThreadId = toOtherAccountEmailId("account-2", "thread-9");
    render(
      createElement(
        InlineEmailList,
        null,
        createElement(InlineEmailCard, { threadid: "thread-1" }, "Mine"),
        createElement(InlineEmailCard, { threadid: otherThreadId }, "Theirs"),
      ),
    );

    fireEvent.click(screen.getAllByRole("button")[0]);

    await waitFor(() => {
      expect(mockArchiveThreadAction).toHaveBeenCalledTimes(2);
    });
    expect(mockArchiveThreadAction).toHaveBeenCalledWith("account-1", {
      threadId: "thread-1",
    });
    expect(mockArchiveThreadAction).toHaveBeenCalledWith("account-2", {
      threadId: "thread-9",
    });
  });
});

describe("InlineEmailCard for another account's email", () => {
  const otherThreadId = toOtherAccountEmailId("account-2", "thread-9");

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({
      emailAccountId: "account-1",
      provider: "google",
      userEmail: "user@example.com",
    });
    mockUseEmailLookup.mockReturnValue(
      new Map([
        [
          otherThreadId,
          {
            messageId: toOtherAccountEmailId("account-2", "msg-9"),
            from: "Legal <legal@acme.example>",
            subject: "Contract renewal",
            snippet: "Renewal terms attached",
            date: "2026-03-11T10:00:00.000Z",
            isUnread: false,
            externalUrl: "https://mail.example/other-account/thread-9",
            account: "other@example.com",
          },
        ],
      ]),
    );
    mockUseThread.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
    });
  });

  it("says which account it is in and acts on it there", async () => {
    mockArchiveThreadAction.mockResolvedValue({});
    render(<InlineEmailCard threadid={otherThreadId}>Renewal</InlineEmailCard>);

    expect(screen.getByText(/other@example\.com/)).toBeTruthy();

    openMoreActions();
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));

    await waitFor(() =>
      expect(mockArchiveThreadAction).toHaveBeenCalledWith("account-2", {
        threadId: "thread-9",
      }),
    );
    // The chat is told of it by the id it knows the email by.
    expect(mockQueueAction).toHaveBeenCalledWith("archive_threads", [
      otherThreadId,
    ]);
  });

  it("loads it through its own account", () => {
    render(<InlineEmailCard threadid={otherThreadId}>Renewal</InlineEmailCard>);

    fireEvent.click(screen.getByText("Renewal"));

    expect(mockUseThread).toHaveBeenCalledWith({ id: "thread-9" });
  });

  it("only links out to an email in an account this browser doesn't know", () => {
    mockUseAccounts.mockReturnValue({ data: { emailAccounts: [] } });
    render(<InlineEmailCard threadid={otherThreadId}>Renewal</InlineEmailCard>);

    openMoreActions();

    expect(screen.queryByRole("menuitem", { name: "Archive" })).toBeNull();
    expect(
      screen
        .getByRole("menuitem", { name: "Open in email" })
        .getAttribute("href"),
    ).toBe("https://mail.example/other-account/thread-9");
  });
});

beforeEach(() => {
  mockUseAccounts.mockReturnValue({
    data: {
      emailAccounts: [
        {
          id: "account-2",
          email: "other@example.com",
          account: { provider: "google" },
        },
      ],
    },
  });
});

function openMoreActions() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "More actions" }), {
    button: 0,
    ctrlKey: false,
  });
}
