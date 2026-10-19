// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReaderReplySuggestion } from "@/app/(app)/[emailAccountId]/mail/use-reader-reply-suggestion";
import type { ThreadMessage } from "@/components/email-list/types";
import type { EmailLabels } from "@/providers/email-label-types";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

const mocks = vi.hoisted(() => ({
  useReplySuggestion: vi.fn(),
  useSuggestedReply: vi.fn(),
  insights: undefined as Record<string, ThreadInsightData> | undefined,
  draftReplies: drafting("on"),
  plans: [] as { status: string; rule: { systemType: string | null } }[],
}));

vi.mock("@/hooks/useReplySuggestion", () => ({
  useReplySuggestion: mocks.useReplySuggestion,
}));
vi.mock("@/hooks/useSuggestedReply", () => ({
  useSuggestedReply: mocks.useSuggestedReply,
}));
vi.mock("@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies", () => ({
  useDraftReplies: () => mocks.draftReplies,
}));
vi.mock("@/hooks/useThreadPlans", () => ({
  useThreadPlans: ({ threadId }: { threadId: string | null }) => ({
    data: threadId ? { plans: mocks.plans } : undefined,
  }),
}));
vi.mock("@/hooks/useInboxInsights", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useInboxInsights")>()),
  useInboxInsights: () => ({ data: mocks.insights }),
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
    mocks.insights = undefined;
    mocks.draftReplies = drafting("on");
    mocks.plans = [];
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

  // Cue files To Reply in its own database, without a mailbox label.
  it("writes a reply to a conversation Cue filed To Reply without a label", () => {
    mocks.plans = [{ status: "APPLIED", rule: { systemType: "TO_REPLY" } }];

    renderSuggestion([incoming("ask", ["INBOX"])]);

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

  // The draft Cue saved keeps its credit when the conversation is reopened.
  it("brings back the suggestion behind a saved draft without writing a new one", () => {
    mocks.useSuggestedReply.mockImplementation(({ enabled, cachedFor }) => ({
      data:
        enabled && cachedFor === "ask"
          ? {
              suggestion: {
                status: "suggested",
                reply: "See you Thursday.",
                citations: [],
              },
            }
          : undefined,
    }));

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

  // "Auto draft replies" off means Cue doesn't write replies in the reader either.
  it("doesn't write a reply while Auto draft replies is off", () => {
    mocks.draftReplies = drafting("off");

    renderSuggestion([incoming("ask", ["INBOX", "Label_to_reply"])]);

    expect(lastEnabled()).toBe(false);
  });

  // Never turned on isn't turned off: nothing drafts unasked, but "Draft a
  // reply" is offered and works.
  it("offers a draft without writing one unasked when drafting was never chosen", () => {
    mocks.draftReplies = drafting("unset");
    const { result } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);

    expect(lastEnabled()).toBe(false);
    expect(result.current.reply.offer).toBe(true);

    act(() => result.current.reply.request());

    expect(lastEnabled()).toBe(true);
    expect(result.current.reply.offer).toBe(false);
  });

  it("waits for the Auto draft replies setting before deciding", () => {
    mocks.draftReplies = drafting("unset", true);
    const { rerender } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);
    expect(lastEnabled()).toBe(false);

    mocks.draftReplies = drafting("on");
    rerender();

    expect(lastEnabled()).toBe(true);
  });

  describe("asked for with Draft a reply", () => {
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
      mocks.draftReplies = drafting("off");
      const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);
      expect(result.current.reply.offer).toBe(false);

      act(() => result.current.reply.request());

      expect(lastEnabled()).toBe(false);
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

function drafting(setting: "on" | "off" | "unset", loading = false) {
  return { enabled: setting === "on", setting, loading };
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
