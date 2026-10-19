// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadMessage } from "@/components/email-list/types";
import {
  rememberReplacedDraftMessage,
  type StoredReplyDraft,
} from "@/utils/mail-engine/reply-drafts";
import {
  EmailThread,
  organizeThreadMessages,
} from "@/components/email-list/EmailThread";
import { hideSendingDraftMessages } from "@/hooks/useHiddenDraftMessageIds";

const { discardDraft } = vi.hoisted(() => ({ discardDraft: vi.fn() }));

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ executeAsync: discardDraft }),
}));
const { scheduledEmails } = vi.hoisted(() => ({
  scheduledEmails: {
    current: [] as { status: string; draftMessageIds: string[] }[],
  },
}));
vi.mock("swr", () => ({
  // useContactPhoto reads the configured fetcher.
  useSWRConfig: () => ({}),
  default: (key: unknown) => ({
    data:
      Array.isArray(key) && key[0] === "/api/user/scheduled-emails"
        ? { scheduledEmails: scheduledEmails.current }
        : undefined,
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccount: undefined,
    emailAccountId: "account-1",
    userEmail: "user@example.com",
  }),
}));
vi.mock("@/env", () => ({ env: { NEXT_PUBLIC_CONTACTS_ENABLED: false } }));
vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/email-list/EmailContents", () => ({
  HtmlEmail: () => null,
  PlainEmail: () => <div data-testid="message-body" />,
}));
vi.mock("@/components/email-list/EmailAttachments", () => ({
  EmailAttachments: () => null,
}));
vi.mock("@/components/email-list/EmailDetails", () => ({
  EmailDetails: () => null,
}));
vi.mock("@/components/email-list/ThreadDeliveryStatus", () => ({
  ThreadDeliveryStatus: () => null,
}));
vi.mock("@/components/email-list/OpenedConversationAttachments", () => ({
  OpenedConversationAttachments: ({
    children,
  }: {
    children: React.ReactNode;
  }) => children,
}));
const { localDrafts } = vi.hoisted(() => ({
  localDrafts: { current: [] as StoredReplyDraft[], isLoading: false },
}));

vi.mock("@/hooks/useReplyDrafts", () => ({
  useReplyDrafts: (
    _accountId: string,
    _threadId: string,
    messageIds: string[],
  ) => ({
    drafts: localDrafts.current.filter((draft) =>
      messageIds.some(
        (id) =>
          draft.messageId === `${id}:reply` ||
          draft.messageId === `${id}:forward`,
      ),
    ),
    isLoading: localDrafts.isLoading,
  }),
}));
vi.mock("@/hooks/useSentMessageOpens", () => ({
  useSentMessageOpens: () => ({ data: undefined }),
}));
vi.mock("@/components/Toast", () => ({ toastError: vi.fn() }));
vi.mock("@/utils/actions/mail", () => ({ deleteDraftAction: vi.fn() }));
vi.mock("@/app/(app)/[emailAccountId]/compose/ComposeEmailFormLazy", () => ({
  ComposeEmailFormLazy: MockComposer,
}));

let composerMounts = 0;

describe("EmailThread reply composer", () => {
  afterEach(cleanup);

  // A sync can append a newer message while a reply is open on what was the
  // latest one; the reply must stay on screen rather than collapse away.
  it("keeps an open reply visible when a newer message arrives", () => {
    const first = createReaderMessage("first", "1000");
    const view = render(
      <EmailThread messages={[first]} refetch={vi.fn()} showReplyButton />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(screen.getByRole("textbox", { name: "Email message" })).toBeTruthy();

    view.rerender(
      <EmailThread
        messages={[first, createReaderMessage("second", "2000")]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(screen.getByRole("textbox", { name: "Email message" })).toBeTruthy();

    view.rerender(
      <EmailThread
        messages={[
          first,
          createReaderMessage("second", "2000"),
          createReaderDraft("other-copy", "3000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    // Only the reply being written is open; the other draft is a row.
    expect(
      screen
        .getAllByRole("textbox", { name: "Email message" })
        .map((editor) => editor.dataset.draftSessionId),
    ).toEqual(["first:reply"]);
    expect(screen.getAllByTestId("collapsed-draft")).toHaveLength(1);

    view.rerender(
      <EmailThread
        messages={[
          {
            ...createReaderMessage("other-parent", "1000"),
            threadId: "thread-2",
          },
          { ...createReaderDraft("other-draft", "2000"), threadId: "thread-2" },
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .draftSessionId,
    ).toBe("other-draft:reply");
  });

  it("opens one mailbox draft at a time and hands back to it after a forward", () => {
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("independent-first", "2000"),
          createReaderDraft("independent-second", "3000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    const openSessions = () =>
      screen
        .getAllByRole("textbox", { name: "Email message" })
        .map((editor) => editor.dataset.draftSessionId);
    // The newest draft is open; the other is a collapsed row.
    expect(openSessions()).toEqual(["independent-second:reply"]);
    expect(screen.getAllByTestId("collapsed-draft")).toHaveLength(1);

    fireEvent.click(screen.getByTestId("collapsed-draft"));
    expect(openSessions()).toEqual(["independent-first:reply"]);

    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(openSessions()).toEqual(["parent:forward"]);
    expect(screen.getAllByTestId("collapsed-draft")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(openSessions()).toEqual(["independent-first:reply"]);
  });

  // Gmail gives a draft a new message ID each time it is saved. When sync
  // brings that replacement in, the draft being edited must keep its composer
  // and local draft instead of reopening as a different, unloaded draft.
  it("keeps editing a saved draft after Gmail replaces its message", () => {
    composerMounts = 0;
    const parent = createReaderMessage("parent", "1000");
    const draftV1 = createReaderDraft("draft-v1", "2000");
    const view = render(
      <EmailThread
        messages={[parent, draftV1]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    const composer = screen.getByRole("textbox", { name: "Email message" });
    expect(composer.dataset.draftSessionId).toBe("draft-v1:reply");

    rememberReplacedDraftMessage("account-1", "draft-v1", "draft-v2");
    for (const messages of [
      [parent, createReaderDraft("draft-v2", "2000"), draftV1],
      [parent, createReaderDraft("draft-v2", "3000")],
    ]) {
      view.rerender(
        <EmailThread
          messages={messages}
          missingBodyIds={new Set(["draft-v2"])}
          refetch={vi.fn()}
          showReplyButton
        />,
      );

      expect(screen.queryByText("Loading message…")).toBeNull();
      const current = screen.getByRole("textbox", { name: "Email message" });
      expect(current.dataset.draftSessionId).toBe("draft-v1:reply");
      expect(current.dataset.providerDraftMessageId).toBe("draft-v2");
      expect(composerMounts).toBe(1);
    }
    view.rerender(
      <EmailThread
        messages={[parent, createReaderDraft("draft-v2", "3000")]}
        autoOpenForwardForMessageId="parent"
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .draftSessionId,
    ).toBe("parent:forward");
    view.rerender(
      <EmailThread
        messages={[parent, createReaderDraft("draft-v2", "3000")]}
        autoOpenReplyForMessageId="parent"
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(
      screen.getAllByRole("textbox", { name: "Email message" }),
    ).toHaveLength(1);
    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .draftSessionId,
    ).toBe("draft-v1:reply");
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    expect(
      screen.getAllByRole("textbox", { name: "Email message" }),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Forward" }));
    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .draftSessionId,
    ).toBe("parent:forward");
  });
});

describe("EmailThread outgoing replies", () => {
  afterEach(cleanup);

  // A queued reply shows in the thread as soon as the composer closes, and the
  // provider's copy takes over the same row so its body does not reload.
  it("shows a queued reply as sent until its sent message takes over the same row", () => {
    const parent = createReaderMessage("parent", "1000");
    const view = render(
      <EmailThread
        messages={[parent]}
        outgoing={[
          {
            operationId: "send-1",
            status: "verifying",
            message: createSentMessage("outgoing:send-1", "3000"),
          },
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    const outgoingRow = view.container.querySelector(
      '[data-thread-message-id="outgoing:send-1"]',
    );
    expect(outgoingRow?.querySelector("time")).toBeTruthy();
    expect(outgoingRow?.textContent).not.toContain("Sending");
    expect(screen.getAllByRole("button", { name: "Reply" })).toHaveLength(2);

    view.rerender(
      <EmailThread
        messages={[parent, createSentMessage("sent-1", "4000")]}
        sendOperationIds={new Map([["sent-1", "send-1"]])}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const sentRow = view.container.querySelector(
      '[data-thread-message-id="sent-1"]',
    );
    expect(sentRow).toBe(outgoingRow);
  });

  // The sent reply becomes the newest message, so selection follows it there,
  // while the message it answered stays open instead of collapsing.
  it("moves selection to a sent reply and keeps the replied-to message open", () => {
    const parent = createReaderMessage("parent", "1000");
    const view = render(
      <EmailThread
        enableMessageNavigation
        messages={[parent]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    view.rerender(
      <EmailThread
        enableMessageNavigation
        messages={[parent]}
        outgoing={[
          {
            operationId: "send-1",
            status: "verifying",
            message: createSentMessage("outgoing:send-1", "3000"),
          },
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const parentRow = view.container.querySelector<HTMLElement>(
      '[data-thread-message-id="parent"]',
    );
    const sentRow = view.container.querySelector<HTMLElement>(
      '[data-thread-message-id="outgoing:send-1"]',
    );
    expect(
      parentRow?.querySelector('[data-testid="message-body"]'),
    ).toBeTruthy();
    expect(parentRow?.dataset.selected).toBe("false");
    expect(sentRow?.dataset.selected).toBe("true");
  });

  // The reply has no provider message yet, so a reply to it threads on the
  // newest message the provider has.
  it("replies to an unsent reply on the thread's latest provider message", () => {
    render(
      <EmailThread
        messages={[createReaderMessage("parent", "1000")]}
        outgoing={[
          {
            operationId: "send-1",
            status: "verifying",
            message: createSentMessage("outgoing:send-1", "3000"),
          },
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const outgoingRow = document.querySelector(
      '[data-thread-message-id="outgoing:send-1"]',
    );
    const reply = Array.from(
      outgoingRow?.querySelectorAll("button") ?? [],
    ).find((button) => button.textContent === "Reply");
    if (!reply) throw new Error("expected a reply button on the sent reply");
    fireEvent.click(reply);

    const composer = screen.getByRole("textbox", { name: "Email message" });
    expect(composer.dataset.draftKeyMessageId).toBe("parent");
    expect(composer.dataset.draftSessionId).toBe("outgoing:send-1:reply");
  });

  it("restores a reply on an outgoing row and keeps it when the sent row takes over", () => {
    localDrafts.current = [
      {
        emailAccountId: "account-1",
        threadId: "thread-1",
        messageId: "outgoing:send-1:reply",
        revision: 1,
        updatedAt: 1000,
        content: { composeMode: "reply" } as StoredReplyDraft["content"],
      },
    ];
    try {
      const parent = createReaderMessage("parent", "1000");
      const view = render(
        <EmailThread
          messages={[parent]}
          outgoing={[
            {
              operationId: "send-1",
              status: "verifying",
              message: createSentMessage("outgoing:send-1", "3000"),
            },
          ]}
          refetch={vi.fn()}
          showReplyButton
        />,
      );
      expect(
        screen.getByRole("textbox", { name: "Email message" }).dataset
          .draftSessionId,
      ).toBe("outgoing:send-1:reply");
      const outgoingRow = document.querySelector(
        '[data-thread-message-id="outgoing:send-1"]',
      );
      const replyButton = Array.from(
        outgoingRow?.querySelectorAll("button") ?? [],
      ).find((button) => button.textContent === "Reply");
      if (!replyButton) throw new Error("expected outgoing reply button");
      fireEvent.click(replyButton);
      view.rerender(
        <EmailThread
          messages={[parent, createSentMessage("sent-1", "3000")]}
          sendOperationIds={new Map([["sent-1", "send-1"]])}
          refetch={vi.fn()}
          showReplyButton
        />,
      );
      expect(
        screen.getByRole("textbox", { name: "Email message" }).dataset
          .draftSessionId,
      ).toBe("outgoing:send-1:reply");
    } finally {
      localDrafts.current = [];
    }
  });

  // Outlook sends a saved draft as that same message. Its local copy is only
  // cleared once the send settles, and must not reopen as a reply meanwhile.
  it("does not reopen a sent draft's local copy as a reply on the sent message", () => {
    localDrafts.current = [
      {
        emailAccountId: "account-1",
        threadId: "thread-1",
        messageId: "draft-1:reply",
        revision: 1,
        content: { composeMode: "reply" } as StoredReplyDraft["content"],
        updatedAt: 1,
      },
    ];
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createSentMessage("draft-1", "4000"),
        ]}
        sendOperationIds={new Map([["draft-1", "send-1"]])}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();
    localDrafts.current = [];
  });
});

describe("EmailThread scheduled send drafts", () => {
  afterEach(() => {
    cleanup();
    scheduledEmails.current = [];
  });

  // A scheduled send goes out from its mailbox draft, which stays in the
  // thread until then. The delivery status stands in for it meanwhile.
  it("hides the mailbox draft of a pending scheduled send", () => {
    scheduledEmails.current = [
      { status: "PENDING", draftMessageIds: ["draft-old", "draft-1"] },
    ];
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("draft-1", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();
  });

  it("shows the draft again once its scheduled send is no longer pending", () => {
    scheduledEmails.current = [
      { status: "FAILED", draftMessageIds: ["draft-1"] },
    ];
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("draft-1", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .providerDraftMessageId,
    ).toBe("draft-1");
  });

  it("hides a draft while its send is held, and shows it again once undone", () => {
    const showDraftAgain = hideSendingDraftMessages("account-1", ["draft-1"]);
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("draft-1", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();

    act(() => showDraftAgain());

    expect(
      screen.getByRole("textbox", { name: "Email message" }).dataset
        .providerDraftMessageId,
    ).toBe("draft-1");
  });
});

describe("EmailThread draft discard", () => {
  afterEach(() => {
    cleanup();
    discardDraft.mockReset();
  });

  // A draft opened from the Drafts folder is the entire conversation, so once
  // it is discarded there is nothing left to read and the reader has to leave.
  it("reports the conversation as gone when its only draft is discarded", async () => {
    const onThreadDiscarded = vi.fn();
    render(
      <EmailThread
        messages={[createReaderDraft("draft-1", "1000")]}
        onThreadDiscarded={onThreadDiscarded}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await act(async () => {});

    expect(onThreadDiscarded).toHaveBeenCalledTimes(1);
  });

  it.each([
    "action error",
    "exception",
  ])("keeps the conversation and restores its draft after a deletion %s", async (failure) => {
    if (failure === "action error") {
      discardDraft.mockResolvedValue({ serverError: "Deletion failed" });
    } else {
      discardDraft.mockRejectedValue(new Error("Deletion failed"));
    }
    const onThreadDiscarded = vi.fn();
    render(
      <EmailThread
        messages={[createReaderDraft("failed-draft", "1000")]}
        onThreadDiscarded={onThreadDiscarded}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await act(async () => {});

    expect(screen.getByRole("textbox", { name: "Email message" })).toBeTruthy();
    expect(onThreadDiscarded).not.toHaveBeenCalled();
  });

  it("keeps a draft-only conversation open while another draft remains", async () => {
    const onThreadDiscarded = vi.fn();
    render(
      <EmailThread
        messages={[
          createReaderDraft("draft-1", "1000"),
          createReaderDraft("draft-2", "2000"),
        ]}
        onThreadDiscarded={onThreadDiscarded}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(
      screen.getAllByRole("button", { name: "Discard draft" })[0],
    );
    await act(async () => {});

    expect(
      screen.getAllByRole("textbox", { name: "Email message" }),
    ).toHaveLength(1);
    expect(onThreadDiscarded).not.toHaveBeenCalled();
  });

  it("keeps the conversation open when a reply draft on a message is discarded", async () => {
    const onThreadDiscarded = vi.fn();
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("draft-1", "2000"),
        ]}
        onThreadDiscarded={onThreadDiscarded}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await act(async () => {});

    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();
    expect(onThreadDiscarded).not.toHaveBeenCalled();
  });
});

describe("EmailThread composer focus", () => {
  afterEach(cleanup);

  // Otherwise a shortcut such as `r` types into the draft instead.
  it("leaves a saved draft unfocused when the conversation opens", () => {
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("saved", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Email message" });
    expect(document.activeElement).not.toBe(editor);
  });

  it("leaves a reply Cue opened on its own unfocused", () => {
    render(
      <EmailThread
        autoOpenReplyForMessageId="parent"
        focusAutoOpenedReply={false}
        messages={[createReaderMessage("parent", "1000")]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const editor = screen.getByRole("textbox", { name: "Email message" });
    expect(document.activeElement).not.toBe(editor);
  });

  it("focuses a reply the user asked for", () => {
    render(
      <EmailThread
        autoOpenReplyForMessageId="parent"
        messages={[createReaderMessage("parent", "1000")]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Email message" }),
    );
  });

  it("focuses the reply when Reply is clicked", () => {
    render(
      <EmailThread
        messages={[createReaderMessage("parent", "1000")]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Email message" }),
    );
  });
});

describe("EmailThread reading a conversation", () => {
  afterEach(cleanup);

  it("offers Reply and Forward under the newest message until a reply opens", () => {
    render(
      <EmailThread
        messages={[
          createReaderMessage("first", "1000"),
          createReaderMessage("latest", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    const bar = screen.getByRole("group", { name: "Reply actions" });
    expect(bar.closest("[data-thread-message-id]")).toBe(
      document.querySelector('[data-thread-message-id="latest"]'),
    );

    fireEvent.click(within(bar).getByRole("button", { name: "Forward" }));

    expect(screen.queryByRole("group", { name: "Reply actions" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Email message" })).toBeTruthy();
  });

  // The reply actions keep their shape whatever Cue is doing about the reply.
  it("keeps the reply actions while Cue explains a reply it held back", () => {
    render(
      <EmailThread
        messages={[createReaderMessage("latest", "1000")]}
        refetch={vi.fn()}
        replyStatus={<p>Cue left this reply to you.</p>}
        showReplyButton
      />,
    );

    expect(screen.getByText("Cue left this reply to you.")).toBeTruthy();
    const bar = screen.getByRole("group", { name: "Reply actions" });
    expect(within(bar).getByRole("button", { name: "Forward" })).toBeTruthy();
  });

  it("moves focus to the first revealed message when earlier ones unfold", () => {
    render(
      <EmailThread
        messages={["1", "2", "3", "4", "5"].map((id) =>
          createReaderMessage(`message-${id}`, `${id}000`),
        )}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Show 3 earlier messages" }),
    );

    expect(document.activeElement).toBe(
      document.querySelector('[data-thread-message-id="message-2"]'),
    );
  });

  it("loads unloaded older messages from the same row that unfolds the loaded ones", () => {
    const onLoad = vi.fn();
    render(
      <EmailThread
        earlierMessages={{ loading: false, onLoad }}
        messages={["1", "2", "3"].map((id) =>
          createReaderMessage(`message-${id}`, `${id}000`),
        )}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(
      Array.from(document.querySelectorAll("[data-thread-message-id]")).map(
        (row) => row.getAttribute("data-thread-message-id"),
      ),
    ).toEqual(["message-3"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Show earlier messages" }),
    );

    expect(onLoad).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll("[data-thread-message-id]")).toHaveLength(
      3,
    );
    expect(document.activeElement).toBe(
      document.querySelector('[data-thread-message-id="message-1"]'),
    );
  });

  it("opens and collapses a message from a real toggle button", () => {
    render(
      <EmailThread
        messages={[
          createReaderMessage("first", "1000"),
          createReaderMessage("latest", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    const first = document.querySelector(
      '[data-thread-message-id="first"]',
    ) as HTMLElement;
    const toggle = first.querySelector("[data-message-toggle]") as HTMLElement;
    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // No button sits inside another control.
    expect(first.querySelector('[role="button"]')).toBeNull();

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(
      within(first).getByRole("button", { name: "Collapse message" }),
    );
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  // Heading navigation steps from message to message, collapsed or not.
  it("heads each message with its sender and date at the level asked for", () => {
    const messages = [
      createReaderMessage("first", "1000"),
      createReaderMessage("latest", "2000"),
    ];
    const { rerender } = render(
      <EmailThread messages={messages} refetch={vi.fn()} showReplyButton />,
    );

    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings).toHaveLength(2);
    for (const heading of headings) {
      expect(heading.textContent).toMatch(
        /^Message from sender@example\.com, /,
      );
      expect(heading.className).toBe("sr-only");
    }

    rerender(
      <EmailThread
        messageHeadingLevel={3}
        messages={messages}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    expect(screen.queryAllByRole("heading", { level: 2 })).toEqual([]);
    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
  });

  it("hands expand-all to an outside toolbar, and takes it back on unmount", () => {
    const onMessageExpansionChange = vi.fn();
    const { unmount } = render(
      <EmailThread
        messages={[
          createReaderMessage("first", "1000"),
          createReaderMessage("latest", "2000"),
        ]}
        onMessageExpansionChange={onMessageExpansionChange}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    // The outside toolbar draws the control, so the thread doesn't.
    expect(
      screen.queryByRole("button", { name: "Expand all messages" }),
    ).toBeNull();
    const controls = onMessageExpansionChange.mock.lastCall?.[0];
    expect(controls).toMatchObject({ allExpanded: false, canExpand: true });

    act(() => controls.onToggleAll());

    expect(onMessageExpansionChange.mock.lastCall?.[0]).toMatchObject({
      allExpanded: true,
    });
    unmount();
    expect(onMessageExpansionChange).toHaveBeenLastCalledWith(undefined);
  });

  it("folds a long run of read messages into one row that reveals them", () => {
    render(
      <EmailThread
        messages={["1", "2", "3", "4", "5"].map((id) =>
          createReaderMessage(`message-${id}`, `${id}000`),
        )}
        refetch={vi.fn()}
        showReplyButton
      />,
    );
    const rows = () =>
      Array.from(document.querySelectorAll("[data-thread-message-id]")).map(
        (row) => row.getAttribute("data-thread-message-id"),
      );
    expect(rows()).toEqual(["message-1", "message-5"]);

    fireEvent.click(
      screen.getByRole("button", { name: "Show 3 earlier messages" }),
    );

    expect(rows()).toEqual([
      "message-1",
      "message-2",
      "message-3",
      "message-4",
      "message-5",
    ]);
  });

  it("keeps a short conversation's earlier messages as their own rows", () => {
    render(
      <EmailThread
        messages={["1", "2", "3"].map((id) =>
          createReaderMessage(`message-${id}`, `${id}000`),
        )}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    expect(
      screen.queryByRole("button", { name: /earlier messages/ }),
    ).toBeNull();
    expect(document.querySelectorAll("[data-thread-message-id]")).toHaveLength(
      3,
    );
  });
});

describe("EmailThread mailbox copies of local replies", () => {
  afterEach(() => {
    cleanup();
    localDrafts.current = [];
    localDrafts.isLoading = false;
  });

  it("edits a reply from its local copy once its mailbox copy syncs back", () => {
    localDrafts.isLoading = true;
    const messages = [
      createReaderMessage("parent", "1000"),
      createReaderDraft("mailbox-copy", "2000"),
    ];
    const view = render(
      <EmailThread messages={messages} refetch={vi.fn()} showReplyButton />,
    );
    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();
    localDrafts.isLoading = false;
    localDrafts.current = [
      {
        emailAccountId: "account-1",
        threadId: "thread-1",
        messageId: "parent:reply",
        revision: 1,
        content: {
          composeMode: "reply",
          providerDraftMessageIds: ["mailbox-copy"],
        } as StoredReplyDraft["content"],
        updatedAt: 1,
      },
    ];
    view.rerender(
      <EmailThread messages={messages} refetch={vi.fn()} showReplyButton />,
    );

    const composers = screen.getAllByRole("textbox", { name: "Email message" });
    expect(composers).toHaveLength(1);
    expect(composers[0]?.dataset.draftSessionId).toBe("parent:reply");
  });

  it("hides a discarded reply's mailbox copy until sync removes it", async () => {
    render(
      <EmailThread
        messages={[
          createReaderMessage("parent", "1000"),
          createReaderDraft("discarded-copy", "2000"),
        ]}
        refetch={vi.fn()}
        showReplyButton
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Discard draft" }));
    await act(async () => {});
    expect(screen.queryByRole("textbox", { name: "Email message" })).toBeNull();
  });
});

describe("organizeThreadMessages", () => {
  it("attaches a draft to the message its headers reply to", () => {
    const first = createMessage({
      id: "first",
      messageId: "<first@example.com>",
    });
    const second = createMessage({
      id: "second",
      messageId: "<second@example.com>",
    });
    const draft = createDraft({
      id: "draft",
      inReplyTo: "<first@example.com>",
    });

    const organized = organizeThreadMessages([first, second, draft]);

    expect(organized.map(({ message }) => message.id)).toEqual([
      "first",
      "second",
    ]);
    expect(organized.at(0)?.draftMessages.map((draft) => draft.id)).toEqual([
      "draft",
    ]);
    expect(organized.at(1)?.draftMessages).toEqual([]);
  });

  it("prefers the last entry of the references header", () => {
    const first = createMessage({
      id: "first",
      messageId: "<first@example.com>",
    });
    const second = createMessage({
      id: "second",
      messageId: "<second@example.com>",
    });
    const draft = createDraft({
      id: "draft",
      references: "<first@example.com> <second@example.com>",
    });

    const organized = organizeThreadMessages([first, second, draft]);

    expect(organized.at(1)?.draftMessages.map((draft) => draft.id)).toEqual([
      "draft",
    ]);
  });

  // Outlook thread messages carry no References header and expose In-Reply-To
  // only when full internet headers are fetched, so its drafts arrive with no
  // parent to match. They were previously dropped from the thread entirely.
  it("shows a draft that has no threading headers on the last message", () => {
    const first = createMessage({
      id: "first",
      messageId: "<first@example.com>",
    });
    const second = createMessage({
      id: "second",
      messageId: "<second@example.com>",
    });
    const draft = createDraft({ id: "outlook-draft" });

    const organized = organizeThreadMessages([first, second, draft]);

    expect(organized).toHaveLength(2);
    expect(organized.at(0)?.draftMessages).toEqual([]);
    expect(organized.at(1)?.draftMessages.map((draft) => draft.id)).toEqual([
      "outlook-draft",
    ]);
  });

  it("shows a draft whose parent is not part of the thread", () => {
    const only = createMessage({ id: "only", messageId: "<only@example.com>" });
    const draft = createDraft({
      id: "draft",
      inReplyTo: "<elsewhere@example.com>",
    });

    const organized = organizeThreadMessages([only, draft]);

    expect(organized.at(0)?.draftMessages.map((draft) => draft.id)).toEqual([
      "draft",
    ]);
  });

  it("falls back to the last message when no message id matches the draft's parent", () => {
    const first = createMessage({ id: "first", messageId: undefined });
    const second = createMessage({ id: "second", messageId: undefined });
    const draft = createDraft({
      id: "draft",
      inReplyTo: "<missing@example.com>",
    });

    const organized = organizeThreadMessages([first, second, draft]);

    expect(organized.at(0)?.draftMessages).toEqual([]);
    expect(organized.at(1)?.draftMessages.map((draft) => draft.id)).toEqual([
      "draft",
    ]);
  });

  it("keeps all drafts when several resolve to the same parent", () => {
    const only = createMessage({ id: "only", messageId: "<only@example.com>" });
    const older = createDraft({
      id: "older-draft",
      internalDate: "1000",
    });
    const newer = createDraft({
      id: "newer-draft",
      internalDate: "2000",
    });

    const organized = organizeThreadMessages([only, newer, older]);

    expect(organized).toHaveLength(1);
    expect(organized.at(0)?.draftMessages.map((draft) => draft.id)).toEqual([
      "older-draft",
      "newer-draft",
    ]);
  });

  it("preserves every draft in a draft-only thread", () => {
    const drafts = [
      createDraft({ id: "first" }),
      createDraft({ id: "second" }),
    ];
    expect(
      organizeThreadMessages(drafts).flatMap(
        ({ draftMessages }) => draftMessages,
      ),
    ).toEqual(drafts);
  });

  it("normalizes folded and trailing whitespace in references", () => {
    const first = createMessage({
      id: "first",
      messageId: "<first@example.com>",
    });
    const last = createMessage({ id: "last", messageId: "<last@example.com>" });
    const draft = createDraft({
      id: "draft",
      references: "<older@example.com>\r\n\t<first@example.com>  ",
    });
    expect(
      organizeThreadMessages([first, last, draft])[0].draftMessages,
    ).toEqual([draft]);
  });

  it("handles an empty thread", () => {
    expect(organizeThreadMessages([])).toEqual([]);
  });
});

function createMessage({
  id,
  messageId,
}: {
  id: string;
  messageId?: string;
}): ThreadMessage {
  return {
    id,
    threadId: "thread",
    labelIds: ["INBOX"],
    headers: { "message-id": messageId },
  } as unknown as ThreadMessage;
}

function createDraft({
  id,
  inReplyTo,
  references,
  internalDate,
}: {
  id: string;
  inReplyTo?: string;
  references?: string;
  internalDate?: string;
}): ThreadMessage {
  return {
    id,
    threadId: "thread",
    labelIds: ["DRAFT"],
    headers: { "in-reply-to": inReplyTo, references },
    internalDate,
  } as unknown as ThreadMessage;
}

function createReaderDraft(id: string, internalDate: string) {
  return {
    ...createReaderMessage(id, internalDate),
    labelIds: ["DRAFT"],
    textHtml: "<p>Saved reply</p>",
  } as ThreadMessage;
}

function MockComposer({
  autoFocus = true,
  draftKeyMessageId,
  draftSessionId,
  providerDraftMessageId,
  onClose,
  onDiscard,
}: {
  autoFocus?: boolean;
  draftKeyMessageId?: string;
  draftSessionId?: string;
  providerDraftMessageId?: string;
  onClose?: () => void;
  onDiscard?: () => void;
}) {
  useState(() => {
    composerMounts += 1;
  });
  return (
    <>
      <textarea
        aria-label="Email message"
        // Like the real composer, it takes focus on mount unless told not to.
        autoFocus={autoFocus}
        data-draft-key-message-id={draftKeyMessageId}
        data-draft-session-id={draftSessionId}
        data-provider-draft-message-id={providerDraftMessageId}
      />
      <button onClick={onClose} type="button">
        Send
      </button>
      <button onClick={onDiscard} type="button">
        Discard draft
      </button>
    </>
  );
}

function createSentMessage(id: string, internalDate: string) {
  return {
    ...createReaderMessage(id, internalDate),
    labelIds: ["SENT"],
  } as ThreadMessage;
}

function createReaderMessage(id: string, internalDate: string) {
  return {
    date: new Date(Number(internalDate)).toISOString(),
    headers: {
      date: new Date(Number(internalDate)).toISOString(),
      from: "sender@example.com",
      subject: "Subject",
      to: "user@example.com",
      "message-id": `<${id}@example.com>`,
    },
    historyId: "history-1",
    id,
    inline: [],
    internalDate,
    labelIds: ["INBOX"],
    snippet: "Preview",
    subject: "Subject",
    textPlain: "Message body",
    threadId: "thread-1",
  } as unknown as ThreadMessage;
}
