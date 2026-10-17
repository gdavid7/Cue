// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { type ReactNode, useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadReader } from "@/app/(app)/[emailAccountId]/mail/ThreadReader";
import type { ThreadMessage } from "@/components/email-list/types";
import { hideSendingDraftMessages } from "@/hooks/useHiddenDraftMessageIds";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_SUPPORT_EMAIL: "support@example.com" },
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "account-1",
    userEmail: "user@example.com",
    accountIds: ["account-1"],
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/ReaderToolbar", () => ({
  ReaderToolbar: ({
    subject,
    messageExpansion,
  }: {
    subject: string;
    messageExpansion?: { canExpand: boolean };
  }) => (
    <header>
      <h1>{subject}</h1>
      <button type="button">More actions</button>
      {messageExpansion?.canExpand ? (
        <button type="button">Expand all messages</button>
      ) : null}
    </header>
  ),
}));
const threadView = vi.hoisted(() => {
  let open = () => {};
  return {
    mode: "ready" as "ready" | "pending" | "gated",
    gate: new Promise<void>((resolve) => {
      open = resolve;
    }),
    open: () => open(),
  };
});
// Rendered directly, so assertions don't depend on which test first awaited
// the lazy chunk. "pending" never loads; "gated" loads on `threadView.open()`.
vi.mock("@/components/email-list/EmailThreadLazy", async () => {
  const { lazy } = await import("react");
  const { EmailThread } = await import("@/components/email-list/EmailThread");
  const PendingThreadView = lazy(() => new Promise<never>(() => {}));
  const GatedThreadView = lazy(() =>
    threadView.gate.then(() => ({ default: EmailThread })),
  );
  return {
    EmailThreadLazy: (props: Parameters<typeof EmailThread>[0]) => {
      if (threadView.mode === "pending") return <PendingThreadView />;
      if (threadView.mode === "gated") return <GatedThreadView {...props} />;
      return <EmailThread {...props} />;
    },
    preloadEmailThread: () => {},
  };
});
vi.mock("@/components/email-list/EmailThread", () => ({
  EmailThread: ({
    onMessageExpansionChange,
    afterLatestMessage,
    autoOpenReplyForMessageId,
    focusAutoOpenedReply,
  }: {
    onMessageExpansionChange?: (controls: {
      allExpanded: boolean;
      canExpand: boolean;
      onToggleAll: () => void;
    }) => void;
    afterLatestMessage?: ReactNode;
    autoOpenReplyForMessageId?: string;
    focusAutoOpenedReply?: boolean;
  }) => (
    <>
      <ReportsExpansion onChange={onMessageExpansionChange} />
      <div data-testid="thread-view" />
      {afterLatestMessage}
      {autoOpenReplyForMessageId ? (
        <div
          data-focused={String(Boolean(focusAutoOpenedReply))}
          data-testid="composer"
        >
          {autoOpenReplyForMessageId}
        </div>
      ) : null}
    </>
  ),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/CueStrip", () => ({
  CueStrip: ({
    emailAccountId,
    onDraftReply,
  }: {
    emailAccountId: string;
    onDraftReply: () => void;
  }) => (
    <section aria-label="Cue summary" data-account={emailAccountId}>
      <button onClick={onDraftReply} type="button">
        Draft reply
      </button>
    </section>
  ),
}));
vi.mock(
  "@/app/(app)/[emailAccountId]/mail/use-reader-reply-suggestion",
  () => ({
    useReaderReplySuggestion: () => ({
      assist: null,
      replyStatus: null,
      reply: replyState,
    }),
  }),
);
vi.mock("@/components/thread-context/ThreadContextList", () => ({
  ThreadContextList: () => <section aria-label="Related" />,
}));
vi.mock("@/components/team-comments/PublisherDiscussion", () => ({
  PublisherDiscussion: () => null,
}));
vi.mock("@/utils/actions/thread-assist", () => ({
  markNeedsReplyAction: vi.fn(),
  saveSuggestedReplyAction: vi.fn(),
}));

const replyState = {
  canRequest: true,
  drafts: true,
  pending: false,
  settledFor: undefined as string | undefined,
  request: vi.fn(),
};

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

describe("ThreadReader", () => {
  afterEach(() => {
    cleanup();
    threadView.mode = "ready";
  });

  it("keeps the toolbar in place while the thread view's code loads", async () => {
    threadView.mode = "gated";
    renderReader({
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
    });
    const moreActions = screen.getByRole("button", { name: "More actions" });
    moreActions.focus();
    expect(screen.getByRole("status").textContent).toBe("Loading email");
    // Expanding needs the thread view, so it waits for it.
    expect(
      screen.queryByRole("button", { name: "Expand all messages" }),
    ).toBeNull();

    await act(async () => threadView.open());

    expect(await screen.findByTestId("thread-view")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions" })).toBe(
      moreActions,
    );
    expect(document.activeElement).toBe(moreActions);
    expect(
      screen.getByRole("button", { name: "Expand all messages" }),
    ).toBeTruthy();
  });

  // A polite status, so a screen reader hears it without focus moving to it.
  it("announces that the email is loading while the thread view's code loads", () => {
    threadView.mode = "pending";

    renderReader({
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
    });

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Loading email");
    expect(status.contains(document.activeElement)).toBe(false);
    // BufferedThreadReader keeps the previous thread up while this marker shows.
    const marker = status.closest("[data-thread-view-loading]");
    expect(marker).toBeTruthy();
    expect(marker?.hasAttribute("hidden")).toBe(false);
  });

  it("announces that the email is loading before any message has arrived", () => {
    renderReader({ loading: true, refetch: vi.fn() });

    expect(screen.getByRole("status").textContent).toBe("Loading email");
  });

  it("explains a thread that failed to load and offers a retry", () => {
    const refetch = vi.fn();

    renderReader({
      error: {
        info: { error: "This conversation isn't available yet." },
        status: 404,
      },
      refetch,
    });

    expect(
      screen.getByText("This conversation isn't available yet."),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("titles the thread from its shown messages, not a draft hidden for a pending send", () => {
    const showDraftAgain = hideSendingDraftMessages("account-1", ["draft-1"]);
    try {
      renderReader({
        refetch: vi.fn(),
        messages: [
          createMessage("message-1", "Quarterly plan", ["INBOX"]),
          createMessage("draft-1", "Re: Quarterly plan", ["DRAFT"]),
        ],
      });

      expect(
        screen.getByRole("heading", { name: "Quarterly plan" }),
      ).toBeTruthy();
    } finally {
      showDraftAgain();
    }
  });

  it("shows related items under a message the user received", () => {
    renderReader({
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
    });

    expect(screen.getByRole("region", { name: "Related" })).toBeTruthy();
  });

  // They help answer a message, and there is nothing to answer in your own.
  it("leaves related items out once the user's reply is newest", () => {
    renderReader({
      refetch: vi.fn(),
      messages: [
        createMessage("message-1", "Office hours", ["INBOX"]),
        {
          ...createMessage("reply-1", "Re: Office hours", ["SENT"]),
          headers: { subject: "Re: Office hours", from: "user@example.com" },
        } as ThreadMessage,
      ],
    });

    expect(screen.queryByRole("region", { name: "Related" })).toBeNull();
  });

  describe("Draft reply from the Cue strip", () => {
    beforeEach(() => {
      replyState.settledFor = undefined;
      replyState.request.mockClear();
    });

    it("asks for Cue's reply, then opens the composer on it once it settles", () => {
      const view = renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      fireEvent.click(screen.getByRole("button", { name: "Draft reply" }));
      expect(replyState.request).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("composer")).toBeNull();

      replyState.settledFor = "message-1";
      view.rerender(view.element());

      const composer = screen.getByTestId("composer");
      expect(composer.textContent).toBe("message-1");
      expect(composer.getAttribute("data-focused")).toBe("true");
    });

    it("leaves the composer closed when Cue settles a reply nobody asked for", () => {
      replyState.settledFor = "message-1";
      renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      expect(screen.queryByTestId("composer")).toBeNull();
    });

    it("scopes the strip to the reader's account", () => {
      renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      expect(
        screen
          .getByRole("region", { name: "Cue summary" })
          .getAttribute("data-account"),
      ).toBe("account-1");
    });
  });
});

function renderReader({
  error,
  loading = false,
  refetch,
  messages = [],
}: {
  error?: Parameters<typeof ThreadReader>[0]["error"];
  loading?: boolean;
  refetch: () => void;
  messages?: ThreadMessage[];
}) {
  const element = () => (
    <NuqsTestingAdapter>
      <ThreadReader
        detailSelectionSettled
        enableMessageNavigation={false}
        error={error}
        labelHref={() => "/labels"}
        layout="split"
        loading={loading}
        messages={messages}
        onArchive={vi.fn()}
        isUnread={false}
        onMarkRead={vi.fn()}
        onMarkUnread={vi.fn()}
        onBackToInbox={vi.fn()}
        refetch={refetch}
        thread={null}
        threadId="thread-1"
        userLabels={{}}
      />
    </NuqsTestingAdapter>
  );
  return { ...render(element()), element };
}

function createMessage(id: string, subject: string, labelIds: string[]) {
  return {
    id,
    threadId: "thread-1",
    labelIds,
    headers: { subject, from: "sender@example.com", date: "" },
  } as unknown as ThreadMessage;
}

function ReportsExpansion({
  onChange,
}: {
  onChange?: (controls: {
    allExpanded: boolean;
    canExpand: boolean;
    onToggleAll: () => void;
  }) => void;
}) {
  useLayoutEffect(() => {
    onChange?.({ allExpanded: false, canExpand: true, onToggleAll: () => {} });
  }, [onChange]);
  return null;
}
