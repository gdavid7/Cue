// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactNode } from "react";
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
  ReaderToolbar: ({ subject }: { subject: string }) => <h1>{subject}</h1>,
}));
// Rendered directly, so assertions don't depend on which test first awaited
// the lazy chunk.
vi.mock("@/components/email-list/EmailThreadLazy", async () => {
  const { EmailThread } = await import("@/components/email-list/EmailThread");
  return { EmailThreadLazy: EmailThread, preloadEmailThread: () => {} };
});
vi.mock("@/components/email-list/EmailThread", () => ({
  EmailThread: ({
    renderToolbar,
    afterLatestMessage,
    autoOpenReplyForMessageId,
    focusAutoOpenedReply,
  }: {
    renderToolbar: () => ReactNode;
    afterLatestMessage?: ReactNode;
    autoOpenReplyForMessageId?: string;
    focusAutoOpenedReply?: boolean;
  }) => (
    <>
      {renderToolbar()}
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
  afterEach(cleanup);

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
  refetch,
  messages = [],
}: {
  error?: Parameters<typeof ThreadReader>[0]["error"];
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
        loading={false}
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
