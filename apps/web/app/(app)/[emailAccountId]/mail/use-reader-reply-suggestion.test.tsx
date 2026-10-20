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
  draftReplies: drafting("on"),
  plans: [] as Record<string, unknown>[],
  mutatePlans: vi.fn(),
  dismiss: vi.fn(),
  recordStage: vi.fn(),
  toastError: vi.fn(),
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
vi.mock("@/hooks/useThreadPlans", () => ({
  useThreadPlans: ({ threadId }: { threadId: string | null }) => ({
    data: threadId ? { plans: mocks.plans } : undefined,
    mutate: mocks.mutatePlans,
  }),
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
  dismissReplySuggestionAction: mocks.dismiss,
  recordReplySuggestionStageAction: mocks.recordStage,
}));
vi.mock("@/components/Toast", () => ({ toastError: mocks.toastError }));

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
    mocks.draftReplies = drafting("on");
    mocks.plans = [];
    mocks.mutatePlans.mockReset();
    mocks.dismiss.mockReset().mockResolvedValue({});
    mocks.recordStage.mockReset().mockResolvedValue({});
    mocks.toastError.mockReset();
  });
  afterEach(cleanup);

  // A rule already wrote the reply: it shows at once as Cue's reply, and Cue
  // doesn't work out another one.
  it("offers the reply a rule wrote, without working out its own", () => {
    mocks.plans = [ruleSuggestionPlan("ask")];

    const { result } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);

    expect(result.current.assist).toMatchObject({
      messageId: "ask",
      reply: "Thursday works for me.",
      executedActionId: "suggestion-1",
    });
    expect(lastEnabled()).toBe(false);
    expect(result.current.reply.offer).toBe(false);
  });

  it.each([
    ["used", "LIKELY_SENT", "ask"],
    ["dismissed", "DISMISSED", "ask"],
    ["for an earlier message", "PENDING", "older"],
  ])("ignores a rule's reply that was %s", (_, draftStatus, messageId) => {
    mocks.plans = [ruleSuggestionPlan(messageId, { draftStatus })];

    const { result } = renderSuggestion([
      incoming("ask", ["INBOX", "Label_to_reply"]),
    ]);

    expect(result.current.assist).toBeNull();
    expect(lastEnabled()).toBe(true);
  });

  // A draft from before replies became suggestions is the mailbox's, not Cue's.
  it("ignores a rule's reply that is already a mailbox draft", () => {
    mocks.plans = [ruleSuggestionPlan("ask", { draftId: "draft-1" })];

    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist).toBeNull();
  });

  it("keeps the rule's reply to itself while drafting is off", () => {
    mocks.draftReplies = drafting("off");
    mocks.plans = [ruleSuggestionPlan("ask")];

    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist).toBeNull();
  });

  // Out of the inbox, or a week old: shown only once the user asks.
  it.each([
    ["archived", ["Label_to_reply"], undefined],
    ["in the trash", ["TRASH"], undefined],
    ["more than a week old", ["INBOX"], "2020-01-01T00:00:00.000Z"],
  ])("waits for Draft a reply when the conversation is %s", (_, labelIds, createdAt) => {
    mocks.plans = [ruleSuggestionPlan("ask", { createdAt })];

    const { result } = renderSuggestion([incoming("ask", labelIds)]);

    expect(result.current.assist).toBeNull();
    expect(result.current.reply.offer).toBe(true);
    expect(lastEnabled()).toBe(false);

    act(() => result.current.reply.request());

    expect(result.current.assist?.reply).toBe("Thursday works for me.");
    // The rule's reply is ready; Cue doesn't work out another.
    expect(lastEnabled()).toBe(false);
  });

  it("carries the rule's recipients, subject and files", () => {
    mocks.plans = [
      ruleSuggestionPlan("ask", {
        subject: "Re: Lease",
        staticAttachments: [
          { type: "FILE", name: "lease.pdf" },
          // A folder the rule draws from is never named as an attachment.
          { type: "FOLDER", name: "Contracts" },
        ],
        selectedAttachments: [
          { filename: "floorplan.pdf" },
          { filename: "lease.pdf" },
        ],
      }),
    ];

    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist).toMatchObject({
      recipients: { subject: "Re: Lease" },
      files: ["lease.pdf", "floorplan.pdf"],
      label: undefined,
    });
  });

  // Never presented as a reply to the sender when it goes to someone else.
  it("labels a rule's reply to someone other than the sender", () => {
    mocks.plans = [ruleSuggestionPlan("ask", { to: "finance@example.com" })];

    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist?.label).toBe(
      "Cue's draft to finance@example.com",
    );
    expect(result.current.assist?.recipients?.to).toBe("finance@example.com");
    expect(result.current.assist?.toSomeoneElse).toBe(true);
  });

  it("doesn't count a rule's reply to the sender as to someone else", () => {
    mocks.plans = [
      ruleSuggestionPlan("ask", { to: "Sender <sender@example.com>" }),
    ];

    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist?.toSomeoneElse).toBe(false);
  });

  // The draft funnel's "shown" stage: once per suggestion, by its ID only.
  it("records the rule's reply as shown once", () => {
    mocks.plans = [ruleSuggestionPlan("ask")];

    const { rerender } = renderSuggestion([incoming("ask", ["INBOX"])]);
    rerender();

    expect(mocks.recordStage).toHaveBeenCalledTimes(1);
    expect(mocks.recordStage).toHaveBeenCalledWith("account-1", {
      executedActionId: expect.any(String),
      stage: "shown",
    });
  });

  it("records nothing as shown for a reply the rule didn't write", () => {
    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    expect(result.current.assist).toBeNull();
    expect(mocks.recordStage).not.toHaveBeenCalled();
  });

  it("dismisses the rule's reply at once, and for good", async () => {
    mocks.plans = [ruleSuggestionPlan("ask")];
    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    await act(async () => {
      result.current.assist?.dismiss?.();
    });

    expect(mocks.dismiss).toHaveBeenCalledWith("account-1", {
      executedActionId: "suggestion-1",
    });
    const [update, options] = mocks.mutatePlans.mock.calls[0];
    expect(options).toEqual({ revalidate: false });
    expect(
      update({ plans: mocks.plans }).plans[0].actionItems[0].draftStatus,
    ).toBe("DISMISSED");
    expect(mocks.toastError).not.toHaveBeenCalled();
  });

  it("brings the rule's reply back when dismissing fails", async () => {
    mocks.dismiss.mockResolvedValue({ serverError: "Nope" });
    mocks.plans = [ruleSuggestionPlan("ask")];
    const { result } = renderSuggestion([incoming("ask", ["INBOX"])]);

    await act(async () => {
      result.current.assist?.dismiss?.();
    });

    expect(mocks.mutatePlans).toHaveBeenLastCalledWith();
    expect(mocks.toastError).toHaveBeenCalled();
  });

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
    expect(result.current.replyStatus).not.toBeNull();

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

  // DR-4: Cue's note decides whether a reply is written unasked; when Gmail
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
      expect(result.current.reply.failed).toBe(false);

      act(() => {
        vi.advanceTimersByTime(REPLY_WAIT_LIMIT_MS - 1);
      });
      expect(result.current.reply.failed).toBe(false);

      act(() => {
        vi.advanceTimersByTime(1);
      });
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

function ruleSuggestionPlan(
  messageId: string,
  action: {
    draftStatus?: string;
    draftId?: string | null;
    createdAt?: string;
    to?: string | null;
    subject?: string | null;
    staticAttachments?: unknown;
    selectedAttachments?: unknown;
  } = {},
) {
  return {
    messageId,
    status: "APPLIED",
    rule: { systemType: "TO_REPLY" },
    actionItems: [
      {
        id: "suggestion-1",
        type: "DRAFT_EMAIL",
        content: "Thursday works for me.",
        draftId: action.draftId ?? null,
        draftStatus: action.draftStatus ?? "PENDING",
        createdAt: action.createdAt ?? new Date().toISOString(),
        to: action.to ?? null,
        cc: null,
        bcc: null,
        subject: action.subject ?? null,
        staticAttachments: action.staticAttachments ?? null,
        selectedAttachments: action.selectedAttachments ?? null,
      },
    ],
  };
}
