// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPLY_WAIT_LIMIT_MS,
  useReaderReplySuggestion,
} from "@/app/(app)/[emailAccountId]/mail/use-reader-reply-suggestion";
import type { ThreadMessage } from "@/components/email-list/types";
import type { EmailLabels } from "@/providers/email-label-types";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

const mocks = vi.hoisted(() => ({
  useReplySuggestion: vi.fn(),
  useSuggestedReply: vi.fn(),
  useThreadContext: vi.fn(),
  insights: undefined as Record<string, ThreadInsightData> | undefined,
  insightError: undefined as unknown,
  draftReplies: { enabled: true, loading: false },
}));

vi.mock("@/hooks/useReplySuggestion", () => ({
  useReplySuggestion: mocks.useReplySuggestion,
}));
vi.mock("@/hooks/useSuggestedReply", () => ({
  useSuggestedReply: mocks.useSuggestedReply,
}));
vi.mock("@/hooks/useThreadContext", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useThreadContext")>()),
  useThreadContext: mocks.useThreadContext,
}));
vi.mock("@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies", () => ({
  useDraftReplies: () => mocks.draftReplies,
}));
vi.mock("@/hooks/useInboxInsights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useInboxInsights")>()),
  useInboxInsights: () => ({
    data: mocks.insights,
    error: mocks.insightError,
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ userEmail: "user@example.com" }),
}));
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/utils/actions/thread-assist", () => ({
  saveSuggestedReplyAction: vi.fn(),
}));

const LABELS: EmailLabels = {
  Label_to_reply: { id: "Label_to_reply", name: "To Reply" },
  Label_marketing: { id: "Label_marketing", name: "Marketing" },
};

describe("useReaderReplySuggestion", () => {
  beforeEach(() => {
    mocks.useReplySuggestion.mockReturnValue({
      phase: "idle",
      suggestion: undefined,
    });
    mocks.useSuggestedReply.mockReturnValue({ data: undefined });
    mocks.useThreadContext.mockReturnValue({ data: { items: [] } });
    mocks.insights = undefined;
    mocks.insightError = undefined;
    mocks.draftReplies = { enabled: true, loading: false };
  });
  afterEach(cleanup);

  it("doesn't write a reply to mail that doesn't need one", () => {
    renderSuggestion([incoming("promo", ["INBOX", "Label_marketing"])]);

    expect(lastEnabled()).toBe(false);
  });

  it("writes a reply to a conversation labelled To Reply", () => {
    renderSuggestion([incoming("ask", ["INBOX", "Label_to_reply"])]);

    expect(lastEnabled()).toBe(true);
  });

  it("writes a reply when the sender is waiting on one", () => {
    mocks.insights = {
      "thread-1": {
        insight: {
          action: "reply",
          task: "Confirm the time",
          date: null,
          dateRole: null,
          fact: null,
          factLabel: null,
        },
        meeting: null,
        reply: null,
      },
    };

    renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(lastEnabled()).toBe(true);
  });

  // DR-4: the note decides whether a reply is written unasked; when Gmail
  // defers reading it, a person's email still gets one.
  it("writes a reply to a person's email when Cue's note on it can't be read", () => {
    mocks.insightError = Object.assign(new Error("Gmail is busy"), {
      status: 503,
      retryAfterMs: 5000,
    });

    renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(lastEnabled()).toBe(true);
  });

  it("waits for Cue's note rather than guessing while it is still coming", () => {
    renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(lastEnabled()).toBe(false);
  });

  // The draft Cue saved keeps its credit when the conversation is reopened.
  it("brings back the suggestion behind a saved draft without writing a new one", () => {
    mocks.useSuggestedReply.mockImplementation(
      ({ enabled, keptOnly, messageId }) => ({
        data:
          enabled && keptOnly && messageId === "ask"
            ? {
                suggestion: {
                  status: "suggested",
                  reply: "See you Thursday.",
                  citations: [],
                },
              }
            : undefined,
      }),
    );

    const { result } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
      {
        ...incoming("draft", ["DRAFT"]),
        headers: { from: "user@example.com" },
      },
    ] as ThreadMessage[]);

    expect(lastEnabled()).toBe(false);
    expect(result.current.assist).toMatchObject({
      messageId: "ask",
      reply: "See you Thursday.",
    });
  });

  it("says what Cue is doing while it checks", () => {
    mocks.useReplySuggestion.mockReturnValue({
      phase: "checking-mail",
      suggestion: undefined,
    });
    const { result } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);

    render(<div>{result.current.replyStatus}</div>);

    expect(screen.getByRole("status")).toBeTruthy();
  });

  // RD-3g: the context the reader gathered is handed over, so the server
  // doesn't read the same related mail and linked pages again.
  it("hands the reader's context to the suggestion once it has it", () => {
    const item = {
      id: "thread-2",
      kind: "web",
      title: "Opening hours",
      snippet: "",
      at: "2026-10-01T00:00:00.000Z",
      reasons: [],
      text: "Open 9 to 5.",
    };
    mocks.useThreadContext.mockReturnValue({ data: undefined });
    const { result, rerender } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);

    expect(lastEnabled()).toBe(false);
    expect(result.current.reply.pending).toBe(true);

    mocks.useThreadContext.mockReturnValue({ data: { items: [item] } });
    rerender();

    expect(mocks.useReplySuggestion).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, context: [item] }),
    );
  });

  // Read back from this browser, the items have no text to hand over.
  it("lets the server gather the context when the reader's has no text", () => {
    mocks.useThreadContext.mockReturnValue({
      data: { items: [{ id: "thread-2", kind: "email", reasons: [] }] },
    });

    renderSuggestion([incoming("ask", ["INBOX", "Label_to_reply"])]);

    expect(mocks.useReplySuggestion).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true, context: undefined }),
    );
  });

  // "Auto draft replies" off means Cue doesn't write replies in the reader either.
  it("doesn't write a reply while Auto draft replies is off", () => {
    mocks.draftReplies = { enabled: false, loading: false };

    renderSuggestion([incoming("ask", ["INBOX", "Label_to_reply"])]);

    expect(lastEnabled()).toBe(false);
  });

  it("waits for the Auto draft replies setting before deciding", () => {
    mocks.draftReplies = { enabled: false, loading: true };
    const { rerender } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);
    expect(lastEnabled()).toBe(false);

    mocks.draftReplies = { enabled: true, loading: false };
    rerender();

    expect(lastEnabled()).toBe(true);
  });

  describe("when a reply takes too long", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("stops spinning and offers to try again once the wait limit passes", () => {
      const retry = vi.fn();
      mocks.useReplySuggestion.mockImplementation(({ enabled }) => ({
        phase: enabled ? "checking-mail" : "idle",
        suggestion: undefined,
        retry,
      }));
      const { result } = renderSuggestion([
        incoming("ask", ["INBOX", "Label_to_reply"]),
      ]);
      expect(result.current.reply.pending).toBe(true);

      act(() => {
        vi.advanceTimersByTime(REPLY_WAIT_LIMIT_MS - 1);
      });
      expect(result.current.reply.pending).toBe(true);
      expect(result.current.reply.failed).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.reply.pending).toBe(false);
      expect(result.current.reply.failed).toBe(true);
      render(<div>{result.current.replyStatus}</div>);
      expect(screen.getByRole("status").textContent).toContain(
        "Couldn't draft a reply right now.",
      );

      act(() => {
        screen.getByRole("button", { name: "Try again" }).click();
      });
      expect(retry).toHaveBeenCalledTimes(1);
      // A new try gets the full wait again.
      expect(result.current.reply.pending).toBe(true);
      expect(result.current.reply.failed).toBe(false);
    });

    it("gives up on a reply whose requests keep failing between retries", () => {
      mocks.useReplySuggestion.mockImplementation(({ enabled }) => ({
        phase: enabled ? "done" : "idle",
        suggestion: undefined,
        error: enabled
          ? Object.assign(new Error("busy"), { status: 503 })
          : undefined,
        retry: vi.fn(),
      }));
      const { result } = renderSuggestion([
        incoming("ask", ["INBOX", "Label_to_reply"]),
      ]);
      expect(result.current.reply.failed).toBe(false);

      act(() => {
        vi.advanceTimersByTime(REPLY_WAIT_LIMIT_MS);
      });

      expect(result.current.reply.failed).toBe(true);
    });

    it("never shows the failure once the reply arrives", () => {
      mocks.useReplySuggestion.mockImplementation(({ enabled }) => ({
        phase: enabled ? "done" : "idle",
        suggestion: enabled
          ? { status: "suggested", reply: "Thursday works.", citations: [] }
          : undefined,
        retry: vi.fn(),
      }));
      const { result } = renderSuggestion([
        incoming("ask", ["INBOX", "Label_to_reply"]),
      ]);

      act(() => {
        vi.advanceTimersByTime(REPLY_WAIT_LIMIT_MS * 2);
      });

      expect(result.current.reply.failed).toBe(false);
      expect(result.current.assist?.reply).toBe("Thursday works.");
    });
  });

  describe("asked for from the Cue strip", () => {
    it("writes a reply to mail from a person that isn't labelled To Reply", () => {
      const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);
      expect(lastEnabled()).toBe(false);

      act(() => result.current.reply.request());

      expect(lastEnabled()).toBe(true);
      expect(mocks.useReplySuggestion).toHaveBeenLastCalledWith(
        expect.objectContaining({
          emailAccountId: "account-1",
          threadId: "thread-1",
        }),
      );
    });

    // The setting turns off every AI-written reply; asking opens the
    // composer straight away instead of waiting on one.
    it("writes none while Auto draft replies is off", () => {
      mocks.draftReplies = { enabled: false, loading: false };
      const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

      act(() => result.current.reply.request());

      expect(lastEnabled()).toBe(false);
      expect(result.current.reply.drafts).toBe(false);
      expect(result.current.reply.settledFor).toBe("ask");
    });

    it("isn't offered when the user wrote the newest message", () => {
      const { result } = renderSuggestion([
        incoming("ask", ["INBOX"]),
        {
          ...incoming("sent", ["SENT"]),
          headers: { from: "user@example.com" },
        },
      ] as ThreadMessage[]);

      act(() => result.current.reply.request());

      expect(result.current.reply.canRequest).toBe(false);
      expect(lastEnabled()).toBe(false);
    });

    it("reports the newest message once its suggestion settles", () => {
      mocks.useReplySuggestion.mockImplementation(({ enabled }) => ({
        phase: enabled ? "done" : "idle",
        suggestion: undefined,
      }));
      const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);
      expect(result.current.reply.settledFor).toBeUndefined();

      act(() => result.current.reply.request());

      expect(result.current.reply.settledFor).toBe("ask");
    });
  });
});

function renderSuggestion(messages: ThreadMessage[]) {
  return renderHook(() =>
    useReaderReplySuggestion({
      emailAccountId: "account-1",
      threadId: "thread-1",
      messages,
      userLabels: LABELS,
      enabled: true,
      onOpenThread: vi.fn(),
    }),
  );
}

function lastEnabled() {
  return mocks.useReplySuggestion.mock.calls.at(-1)?.[0].enabled;
}

function incoming(id: string, labelIds: string[]) {
  return {
    id,
    threadId: "thread-1",
    labelIds,
    headers: {
      from: "Sender <sender@example.com>",
      to: "user@example.com",
      subject: "Subject",
      date: new Date(0).toISOString(),
    },
  } as unknown as ThreadMessage;
}
