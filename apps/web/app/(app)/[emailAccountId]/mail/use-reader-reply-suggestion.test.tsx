// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
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
  insights: undefined as Record<string, ThreadInsightData> | undefined,
}));

vi.mock("@/hooks/useReplySuggestion", () => ({
  useReplySuggestion: mocks.useReplySuggestion,
}));
vi.mock("@/hooks/useInboxInsights", () => ({
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
    mocks.insights = undefined;
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

  it("offers Reply while Cue is still checking", () => {
    mocks.useReplySuggestion.mockReturnValue({
      phase: "checking-mail",
      suggestion: undefined,
    });
    const onReply = vi.fn();
    const { result } = renderSuggestion(
      [incoming("ask", ["INBOX", "Label_to_reply"])],
      onReply,
    );

    render(<div>{result.current.idleReplyArea}</div>);
    fireEvent.click(screen.getByRole("button", { name: "Reply" }));

    expect(onReply).toHaveBeenCalledWith("ask");
  });
});

function renderSuggestion(messages: ThreadMessage[], onReply = vi.fn()) {
  return renderHook(() =>
    useReaderReplySuggestion({
      emailAccountId: "account-1",
      threadId: "thread-1",
      messages,
      userLabels: LABELS,
      enabled: true,
      onOpenThread: vi.fn(),
      onReply,
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
