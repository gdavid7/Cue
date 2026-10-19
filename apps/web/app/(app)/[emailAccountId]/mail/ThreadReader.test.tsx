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
    subjectHeadingLevel = 1,
    messageExpansion,
  }: {
    subject: string;
    subjectHeadingLevel?: number;
    messageExpansion?: { canExpand: boolean };
  }) => (
    <header>
      <div aria-level={subjectHeadingLevel} role="heading">
        {subject}
      </div>
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
    replyStatus,
    messageHeadingLevel = 2,
    earlierMessages,
    onThreadDiscarded,
  }: {
    messageHeadingLevel?: number;
    earlierMessages?: unknown;
    onThreadDiscarded?: () => void;
    onMessageExpansionChange?: (controls: {
      allExpanded: boolean;
      canExpand: boolean;
      onToggleAll: () => void;
    }) => void;
    afterLatestMessage?: ReactNode;
    autoOpenReplyForMessageId?: string;
    focusAutoOpenedReply?: boolean;
    replyStatus?: ReactNode;
  }) => (
    <>
      <ReportsExpansion onChange={onMessageExpansionChange} />
      <div
        data-earlier-messages-row={String(Boolean(earlierMessages))}
        data-leaves-when-discarded={String(Boolean(onThreadDiscarded))}
        data-testid="thread-view"
      >
        <div aria-level={messageHeadingLevel} role="heading">
          Message from sender
        </div>
      </div>
      {afterLatestMessage}
      {replyStatus}
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
  CueStrip: ({ emailAccountId }: { emailAccountId: string }) => (
    <section aria-label="Cue summary" data-account={emailAccountId} />
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
  ThreadContextList: ({ headingLevel = 3 }: { headingLevel?: number }) => (
    <section aria-label="Related">
      <div aria-level={headingLevel} role="heading">
        Related
      </div>
    </section>
  ),
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
  offer: true,
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

  // Heading navigation goes subject, then each message, then what's inside
  // one, with no level skipped. Beside the list, whose view name is the
  // page's h1, everything sits one level lower.
  it.each([
    { layout: "list" as const, levels: [1, 2, 3] },
    { layout: "split" as const, levels: [2, 3, 4] },
  ])("nests its headings without a gap in the $layout layout", ({
    layout,
    levels,
  }) => {
    renderReader({
      layout,
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
    });

    const level = (name: string) =>
      Number(screen.getByRole("heading", { name }).getAttribute("aria-level"));
    expect([
      level("Office hours"),
      level("Message from sender"),
      level("Related"),
    ]).toEqual(levels);
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

  // Most fills find nothing older; a row held for them would go away again
  // and move the newest message up after it had painted.
  it("holds no earlier-messages row while a fill looks for older messages", () => {
    renderReader({
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
      localAvailability: { hasMore: false, filling: true },
    });

    const view = screen.getByTestId("thread-view");
    expect(view.getAttribute("data-earlier-messages-row")).toBe("false");
    // Until the fill settles the conversation may be more than it looks.
    expect(view.getAttribute("data-leaves-when-discarded")).toBe("false");
  });

  it("offers earlier messages the conversation is known to have", () => {
    renderReader({
      refetch: vi.fn(),
      messages: [createMessage("message-1", "Office hours", ["INBOX"])],
      localAvailability: { hasMore: true, filling: false },
    });

    expect(
      screen
        .getByTestId("thread-view")
        .getAttribute("data-earlier-messages-row"),
    ).toBe("true");
  });

  describe("Draft a reply", () => {
    beforeEach(() => {
      replyState.offer = true;
      replyState.settledFor = undefined;
      replyState.request.mockClear();
    });

    it("asks for Cue's reply, then opens the composer on it once it settles", () => {
      const view = renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      fireEvent.click(screen.getByRole("button", { name: "Draft a reply" }));
      expect(replyState.request).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId("composer")).toBeNull();

      replyState.settledFor = "message-1";
      view.rerender(view.element());

      const composer = screen.getByTestId("composer");
      expect(composer.textContent).toBe("message-1");
      expect(composer.getAttribute("data-focused")).toBe("true");
    });

    // One place to ask: the Cue strip has no draft button of its own.
    it("is offered once, under the reply actions", () => {
      renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      expect(
        screen.getAllByRole("button", { name: /draft (a )?reply/i }),
      ).toHaveLength(1);
    });

    it("isn't offered when Cue doesn't write replies here", () => {
      replyState.offer = false;
      renderReader({
        refetch: vi.fn(),
        messages: [createMessage("message-1", "Start date", ["INBOX"])],
      });

      expect(
        screen.queryByRole("button", { name: "Draft a reply" }),
      ).toBeNull();
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
  layout = "split",
  refetch,
  messages = [],
  localAvailability,
}: {
  error?: Parameters<typeof ThreadReader>[0]["error"];
  loading?: boolean;
  layout?: "list" | "split";
  refetch: () => void;
  messages?: ThreadMessage[];
  localAvailability?: { hasMore: boolean; filling: boolean };
}) {
  const element = () => (
    <NuqsTestingAdapter>
      <ThreadReader
        detailSelectionSettled
        enableMessageNavigation={false}
        error={error}
        labelHref={() => "/labels"}
        layout={layout}
        loading={loading}
        localAvailability={
          localAvailability && {
            ...localAvailability,
            missingBodyIds: new Set(),
            outgoing: [],
            sendOperationIds: new Map(),
            loadingMore: false,
            loadMore: vi.fn(),
          }
        }
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
