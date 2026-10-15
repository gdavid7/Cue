/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Messages } from "@/components/assistant-chat/messages";
import type { ChatMessage } from "@/components/assistant-chat/types";

vi.mock("@/components/assistant-chat/message-part", () => ({
  MessagePart: ({ part }: { part: { text?: string } }) => <p>{part.text}</p>,
}));

vi.mock("@/components/assistant-chat/messaging-channel-hint", () => ({
  MessagingChannelHint: () => null,
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

describe("Messages", () => {
  afterEach(cleanup);

  it("keeps the input area out of the conversation log", () => {
    render(view("ready", []));

    const log = screen.getByRole("log");
    expect(log.contains(screen.getByRole("textbox", { name: "Draft" }))).toBe(
      false,
    );
  });

  // Streamed Markdown re-renders on every chunk, which screen readers read
  // as repeated fragments; one status line says what is happening instead.
  it("announces that Cue is answering and when it is done, not each chunk", () => {
    const { rerender } = render(view("ready", [userMessage]));
    expect(screen.getByRole("status").textContent).toBe("");

    rerender(view("submitted", [userMessage]));
    expect(screen.getByRole("status").textContent).toBe("Cue is thinking…");

    rerender(view("streaming", [userMessage, reply("Here are")]));
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("off");
    expect(screen.getByRole("status").textContent).toBe("Cue is thinking…");

    rerender(view("ready", [userMessage, reply("Here are your bills.")]));
    expect(screen.getByRole("log").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("status").textContent).toBe("Cue replied");
  });
});

const userMessage = {
  id: "user-1",
  role: "user",
  parts: [{ type: "text", text: "Find my bills" }],
} as ChatMessage;

function reply(text: string) {
  return {
    id: "assistant-1",
    role: "assistant",
    parts: [{ type: "text", text }],
  } as ChatMessage;
}

function view(
  status: "ready" | "submitted" | "streaming",
  messages: ChatMessage[],
) {
  return (
    <Messages
      footer={<textarea aria-label="Draft" />}
      isArtifactVisible={false}
      messages={messages}
      persistedMessageIds={new Set()}
      regenerate={vi.fn()}
      setMessages={vi.fn()}
      status={status}
    />
  );
}
