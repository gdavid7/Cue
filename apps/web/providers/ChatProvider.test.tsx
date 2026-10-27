// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { DefaultChatTransport } from "ai";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/components/assistant-chat/types";
import { ASSISTANT_CHAT_MAX_TEXT_LENGTH } from "@/utils/actions/assistant-chat.validation";
import type { MessageContext } from "@/utils/ai/assistant/chat-context-validation";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { getDefaultStore } from "jotai";
import { openThreadAtom } from "@/store/open-thread";
import { ChatProvider, useChat } from "./ChatProvider";

const {
  mockClientLoggerError,
  mockClientLoggerFlush,
  mockClientLoggerWarn,
  mockSetMessages,
  mockSetQueryState,
  mockSendMessage,
  mockToastError,
  mockUseChatMessages,
  mockUseSWRConfig,
  mockConvertToUIMessages,
  mockCaptureException,
  mockChatTransport,
  mockChatStop,
  mockResumeStream,
  accountState,
  chatState,
  queryState,
} = vi.hoisted(() => ({
  mockClientLoggerError: vi.fn(),
  mockClientLoggerFlush: vi.fn(),
  mockClientLoggerWarn: vi.fn(),
  mockSetMessages: vi.fn(),
  mockSetQueryState: vi.fn(),
  mockSendMessage: vi.fn(),
  mockToastError: vi.fn(),
  mockUseChatMessages: vi.fn(),
  mockUseSWRConfig: vi.fn(),
  mockConvertToUIMessages: vi.fn(),
  mockCaptureException: vi.fn(),
  mockChatTransport: vi.fn(),
  mockChatStop: vi.fn(),
  mockResumeStream: vi.fn(),
  accountState: {
    emailAccountId: "account-a",
    disconnectedA: null as string | null,
    disconnectedB: null as string | null,
    accountsLoading: false,
    accountsError: undefined as Error | undefined,
    accountsWithoutB: false,
    withAccountC: false,
    keepDataOnError: false,
  },
  chatState: {
    id: "new-chat-id",
    status: "ready" as "ready" | "submitted" | "streaming" | "error",
    messages: [] as Array<{ id: string; role: string }>,
    onError: undefined as ((error: Error) => void) | undefined,
  },
  queryState: {
    initialChatId: "chat-from-account-a" as string | null,
    initial: {} as Record<string, string | null>,
    set: {} as Record<string, string | null>,
  },
}));

const { mockSubmitLocalMailSearchResult, localSearchState } = vi.hoisted(
  () => ({
    mockSubmitLocalMailSearchResult: vi.fn(async () => ({ data: undefined })),
    localSearchState: {
      onData: undefined as ((part: unknown) => void) | undefined,
    },
  }),
);
vi.mock("@/utils/actions/assistant-chat", () => ({
  submitLocalMailSearchResult: mockSubmitLocalMailSearchResult,
}));

vi.mock("@ai-sdk/react", () => ({
  useChat: (options: {
    onError?: (error: Error) => void;
    onData?: (part: unknown) => void;
  }) => {
    chatState.onError = options.onError;
    localSearchState.onData = options.onData;
    return {
      id: chatState.id,
      messages: chatState.messages,
      status: chatState.status,
      setMessages: mockSetMessages,
      sendMessage: (message: unknown, requestOptions?: { body?: unknown }) =>
        mockSendMessage(message, requestOptions).catch((error) => {
          options.onError?.(error);
          throw error;
        }),
      stop: mockChatStop,
      resumeStream: mockResumeStream,
      regenerate: vi.fn(),
    };
  },
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  mockChatTransport.mockImplementation(function (options) {
    return new actual.DefaultChatTransport(options);
  });
  return { ...actual, DefaultChatTransport: mockChatTransport };
});

vi.mock("nuqs", async () => {
  const React = await vi.importActual<typeof import("react")>("react");

  return {
    parseAsString: {},
    useQueryState: (key: string) => {
      const [value, setValue] = React.useState<string | null>(
        key === "chatId"
          ? queryState.initialChatId
          : (queryState.initial[key] ?? null),
      );

      return [
        value,
        (nextValue: string | null) => {
          if (key === "chatId") mockSetQueryState(nextValue);
          else queryState.set[key] = nextValue;
          setValue(nextValue);
        },
      ] as const;
    },
  };
});

vi.mock("swr", () => ({
  useSWRConfig: () => mockUseSWRConfig(),
}));

vi.mock("@/hooks/useChatMessages", () => ({
  useChatMessages: (chatId: string | null) => mockUseChatMessages(chatId),
  chatMessagesKey: (chatId: string) => `/api/chats/${chatId}`,
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: accountState.emailAccountId,
    accountIds: accountState.withAccountC
      ? ["account-a", "account-b", "account-c"]
      : ["account-a", "account-b"],
  }),
}));

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    error: accountState.accountsError,
    data:
      accountState.accountsLoading ||
      (accountState.accountsError && !accountState.keepDataOnError)
        ? undefined
        : {
            emailAccounts: [
              {
                id: "account-a",
                email: "a@example.com",
                account: { disconnectedAt: accountState.disconnectedA },
              },
              ...(accountState.accountsWithoutB
                ? []
                : [
                    {
                      id: "account-b",
                      email: "b@example.com",
                      account: { disconnectedAt: accountState.disconnectedB },
                    },
                  ]),
              ...(accountState.withAccountC
                ? [
                    {
                      id: "account-c",
                      email: "c@example.com",
                      account: { disconnectedAt: null },
                    },
                  ]
                : []),
            ],
          },
  }),
}));

vi.mock("@/components/assistant-chat/helpers", () => ({
  convertToUIMessages: mockConvertToUIMessages,
}));

vi.mock("@/utils/error", () => ({
  captureException: mockCaptureException,
}));

vi.mock("@/components/Toast", () => ({
  toastError: mockToastError,
}));

vi.mock("@/utils/logger-client", () => ({
  createClientLogger: () => ({
    error: mockClientLoggerError,
    flush: mockClientLoggerFlush,
    warn: mockClientLoggerWarn,
  }),
}));

afterEach(() => {
  cleanup();
  accountState.withAccountC = false;
});

describe("ChatProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    accountState.emailAccountId = "account-a";
    accountState.disconnectedA = null;
    accountState.disconnectedB = null;
    accountState.accountsLoading = false;
    accountState.accountsError = undefined;
    accountState.accountsWithoutB = false;
    accountState.keepDataOnError = false;
    chatState.id = "new-chat-id";
    chatState.status = "ready";
    chatState.messages = [];
    setVisibility("visible");
    mockChatStop.mockResolvedValue(undefined);
    mockResumeStream.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    queryState.initialChatId = "chat-from-account-a";
    queryState.initial = {};
    queryState.set = {};
    mockUseSWRConfig.mockReturnValue({ mutate: vi.fn() });
    mockUseChatMessages.mockImplementation((chatId: string | null) =>
      chatId
        ? {
            data: {
              messages: [
                {
                  id: "message-from-account-a",
                  role: "user",
                  parts: [{ type: "text", text: "Old chat" }],
                },
              ],
            },
          }
        : { data: undefined },
    );
    mockConvertToUIMessages.mockReturnValue([
      {
        id: "message-from-account-a",
        role: "user",
        parts: [{ type: "text", text: "Old chat" }],
      },
    ]);
    mockClientLoggerFlush.mockResolvedValue(undefined);
    mockSendMessage.mockResolvedValue(undefined);
  });

  it("uses attached fix context only for the next message", async () => {
    const fixContext = buildFixRuleContext("first-thread");
    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setContext(fixContext);
    });
    await waitFor(() => {
      expect(latestContext?.context).toEqual(fixContext);
    });

    await act(async () => {
      await latestContext?.submitTextMessage("Fix this rule");
    });

    expect(mockSendMessage.mock.calls[0]?.[1]).toEqual({
      body: { context: fixContext },
    });
    expect(latestContext?.context).toBeNull();

    await act(async () => {
      await latestContext?.submitTextMessage("Now answer a new question");
    });

    expect(mockSendMessage.mock.calls[1]?.[1]).toBeUndefined();
  });

  it("starts a new chat about another account's rules in that account", async () => {
    queryState.initialChatId = null;
    const fixContext = buildFixRuleContext("b-thread");
    let latestContext: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latestContext = useChat();
      return null;
    }
    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setContext(fixContext, { accountId: "account-b" });
    });

    await waitFor(() => {
      expect(latestContext?.context).toEqual(fixContext);
    });
    expect(latestContext?.chatAccount?.id).toBe("account-b");
    const body = await sendThroughTransport();
    expect(body.headers[EMAIL_ACCOUNT_HEADER.toLowerCase()]).toBe("account-b");
  });

  it("starts over in the fixed email's account when a conversation is held by another", async () => {
    queryState.initialChatId = "chat-from-account-a";
    const fixContext = buildFixRuleContext("b-thread");
    let latestContext: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latestContext = useChat();
      return null;
    }
    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setContext(fixContext, { accountId: "account-b" });
    });

    await waitFor(() => {
      expect(latestContext?.chatAccount?.id).toBe("account-b");
    });
    expect(latestContext?.chatId).toBeNull();
    expect(latestContext?.context).toEqual(fixContext);
  });

  it("restores consumed fix context when sending fails", async () => {
    const fixContext = buildFixRuleContext("failed-thread");
    mockSendMessage.mockRejectedValueOnce(new Error("Network request failed"));
    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setContext(fixContext);
    });
    await waitFor(() => {
      expect(latestContext?.context).toEqual(fixContext);
    });

    await act(async () => {
      await expect(
        latestContext?.submitTextMessage("Fix this rule"),
      ).rejects.toThrow("Network request failed");
    });

    expect(mockSendMessage.mock.calls[0]?.[1]).toEqual({
      body: { context: fixContext },
    });
    expect(latestContext?.context).toEqual(fixContext);
  });

  it("keeps an in-progress reply when the saved chat refetches mid-run", async () => {
    const savedUserOnly = [
      {
        id: "user-message",
        role: "user",
        parts: [{ type: "text", text: "Hi" }],
      },
    ];
    const savedWithReply = [
      ...savedUserOnly,
      {
        id: "assistant-message",
        role: "assistant",
        parts: [{ type: "text", text: "Done" }],
      },
    ];
    let savedData = { messages: savedUserOnly };
    mockUseChatMessages.mockImplementation(() => ({ data: savedData }));
    mockConvertToUIMessages.mockImplementation(
      (data: { messages: unknown[] }) => data.messages,
    );

    const { rerender } = renderWithProvider(<div />);
    mockSetMessages.mockClear();

    // A focus refetch lands while the reply streams; the server has only saved
    // the user message so far.
    chatState.status = "streaming";
    savedData = { messages: [...savedUserOnly] };
    rerender(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );
    expect(mockSetMessages).not.toHaveBeenCalled();

    // The run ends before its refetch returns: the stale mid-run data must not
    // replace the finished reply.
    chatState.status = "ready";
    rerender(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );
    expect(mockSetMessages).not.toHaveBeenCalled();

    // The refetch after the run returns the saved reply.
    savedData = { messages: savedWithReply };
    rerender(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );
    expect(mockSetMessages).toHaveBeenLastCalledWith(savedWithReply);
  });

  it("loads another chat's history when switching chats during a run", () => {
    const otherChat = [
      {
        id: "other-message",
        role: "user",
        parts: [{ type: "text", text: "Other" }],
      },
    ];
    let savedData: { messages: unknown[] } = { messages: [] };
    mockUseChatMessages.mockImplementation(() => ({ data: savedData }));
    mockConvertToUIMessages.mockImplementation(
      (data: { messages: unknown[] }) => data.messages,
    );

    chatState.status = "streaming";
    const { rerender } = renderWithProvider(<div />);
    mockSetMessages.mockClear();

    // Selecting another chat gives the SDK a fresh, idle chat instance.
    chatState.id = "other-chat";
    chatState.status = "ready";
    savedData = { messages: otherChat };
    rerender(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );
    expect(mockSetMessages).toHaveBeenLastCalledWith(otherChat);
  });

  it("clears the active chat when the selected email account changes", async () => {
    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    const { rerender } = renderWithProvider(<Consumer />);

    await waitFor(() => {
      expect(latestContext?.chatId).toBe("chat-from-account-a");
    });

    accountState.emailAccountId = "account-b";
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => {
      expect(latestContext?.chatId).toBeNull();
    });
    expect(mockSetQueryState).toHaveBeenCalledWith(null);
    expect(mockSetMessages).toHaveBeenLastCalledWith([]);
  });

  it("retains the draft and records safe metadata when sending fails", async () => {
    const draft = "Keep this draft if the request fails";
    const error = new Error("Network request failed");
    mockSendMessage.mockRejectedValueOnce(error);

    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setInput(draft);
    });
    await waitFor(() => {
      expect(latestContext?.input).toBe(draft);
    });

    act(() => {
      latestContext?.handleSubmit();
    });

    await waitFor(() => {
      expect(latestContext?.input).toBe(draft);
    });
    expect(mockClientLoggerError).toHaveBeenCalledWith(
      "Assistant chat request failed",
      expect.objectContaining({
        attachmentCount: 0,
        emailAccountId: "account-a",
        failureCategory: "request_error",
        textLength: draft.length,
      }),
    );
    expect(JSON.stringify(mockClientLoggerError.mock.calls)).not.toContain(
      draft,
    );
    expect(mockToastError).toHaveBeenCalledWith({
      description: "We couldn't send your message. Please try again.",
    });
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  it("shows the server's message when the user is over the rate limit", async () => {
    const error = Object.assign(new Error("rate limited"), {
      statusCode: 429,
      responseBody: JSON.stringify({
        error: "Cue needs a short break. Try again in a few minutes.",
        isKnownError: true,
      }),
    });
    mockSendMessage.mockRejectedValueOnce(error);

    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setInput("One more question");
    });
    await waitFor(() => {
      expect(latestContext?.input).toBe("One more question");
    });
    act(() => {
      latestContext?.handleSubmit();
    });

    await waitFor(() => {
      expect(mockToastError).toHaveBeenCalledWith({
        description: "Cue needs a short break. Try again in a few minutes.",
      });
    });
    expect(latestContext?.input).toBe("One more question");
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("rejects oversized drafts before sending and keeps their content", async () => {
    const draft = "a".repeat(ASSISTANT_CHAT_MAX_TEXT_LENGTH + 1);
    let latestContext: ReturnType<typeof useChat> | undefined;

    function Consumer() {
      latestContext = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    act(() => {
      latestContext?.setInput(draft);
    });
    await waitFor(() => {
      expect(latestContext?.input).toBe(draft);
    });

    act(() => {
      latestContext?.handleSubmit();
    });

    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(latestContext?.input).toBe(draft);
    expect(mockToastError).toHaveBeenCalledWith({
      description: "Messages can be up to 20,000 characters.",
    });
    expect(mockClientLoggerWarn).toHaveBeenCalledWith(
      "Assistant chat input rejected",
      expect.objectContaining({
        emailAccountId: "account-a",
        failureCategory: "message_too_long",
        maxTextLength: ASSISTANT_CHAT_MAX_TEXT_LENGTH,
        textLength: draft.length,
      }),
    );
    expect(JSON.stringify(mockClientLoggerWarn.mock.calls)).not.toContain(
      draft,
    );
  });

  it.each([
    "submit-message",
    "regenerate-message",
  ] as const)("declares inline email card support in %s requests", async (trigger) => {
    renderWithProvider(null);
    const transport = mockChatTransport.mock.results.at(-1)
      ?.value as DefaultChatTransport<ChatMessage>;
    const message = {
      id: "user-message",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Summarize my inbox" }],
    };
    vi.mocked(fetch).mockResolvedValueOnce(new Response("data: [DONE]\n\n"));

    await transport.sendMessages({
      trigger,
      chatId: "chat-1",
      messageId: undefined,
      abortSignal: undefined,
      messages: [message],
      body: { context: buildFixRuleContext("thread-1") },
    });

    const [url, request] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(url).toBe("/api/chat");
    expect(JSON.parse(request?.body as string)).toEqual({
      id: "chat-1",
      message,
      supportsInlineEmailCards: true,
      localMailSearch: false,
      localMailSearchSyntaxes: ["gmail", "outlook"],
      localMailCount: false,
      context: buildFixRuleContext("thread-1"),
    });
  });

  it.each([
    [
      "names the thread open in this account and its latest message",
      "account-a",
      { openThreadId: "t-42", openMessageId: "m-7" },
    ],
    [
      "names a thread open in another account with its account",
      "account-b",
      {
        openThreadId: "acct:account-b:t-42",
        openMessageId: "acct:account-b:m-7",
      },
    ],
  ])("%s", async (_name, ownerAccountId, expected) => {
    getDefaultStore().set(openThreadAtom, {
      emailAccountId: ownerAccountId,
      threadId: "t-42",
      messageId: "m-7",
    });
    renderWithProvider(null);
    const transport = mockChatTransport.mock.results.at(-1)
      ?.value as DefaultChatTransport<ChatMessage>;
    vi.mocked(fetch).mockResolvedValueOnce(new Response("data: [DONE]\n\n"));

    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        {
          id: "user-message",
          role: "user",
          parts: [{ type: "text", text: "What's this about?" }],
        },
      ],
    });
    getDefaultStore().set(openThreadAtom, null);

    const [, request] = vi.mocked(fetch).mock.calls.at(-1)!;
    const body = JSON.parse(request?.body as string);
    expect({
      openThreadId: body.openThreadId,
      openMessageId: body.openMessageId,
    }).toEqual(expected);
  });

  it("answers the assistant's local mail searches for this account", async () => {
    renderWithProvider(null);

    localSearchState.onData?.({
      type: "data-local-mail-search",
      data: {
        requestId: "8d4a1f8e-5f5c-4b9b-9a51-4f1f0e7a2c11",
        query: "from:jobs@acme.com",
        limit: 20,
      },
    });

    // No mail engine runs in this test, so it says so straight away.
    await vi.waitFor(() =>
      expect(mockSubmitLocalMailSearchResult).toHaveBeenCalledWith(
        "account-a",
        {
          requestId: "8d4a1f8e-5f5c-4b9b-9a51-4f1f0e7a2c11",
          result: { status: "unavailable", reason: "no_engine" },
        },
      ),
    );
  });

  it("tells the server whether this tab can search its local mail", async () => {
    renderWithProvider(null);
    const transport = mockChatTransport.mock.results.at(-1)
      ?.value as DefaultChatTransport<ChatMessage>;
    vi.mocked(fetch).mockResolvedValueOnce(new Response("data: [DONE]\n\n"));

    await transport.sendMessages({
      trigger: "submit-message",
      chatId: "chat-1",
      messageId: undefined,
      abortSignal: undefined,
      messages: [
        {
          id: "user-message",
          role: "user",
          parts: [{ type: "text", text: "Any interviews?" }],
        },
      ],
    });

    const [, request] = vi.mocked(fetch).mock.calls.at(-1)!;
    expect(JSON.parse(request?.body as string).localMailSearch).toBe(false);
  });

  it("resumes the existing reply without starting another generation", async () => {
    renderWithProvider(null);
    const transport = mockChatTransport.mock.results.at(-1)
      ?.value as DefaultChatTransport<ChatMessage>;
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await transport.reconnectToStream({ chatId: "chat-1" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/chat/chat-1/stream",
      expect.objectContaining({
        method: "GET",
        headers: { [EMAIL_ACCOUNT_HEADER.toLowerCase()]: "account-a" },
      }),
    );
  });
});

describe("ChatProvider interrupted replies", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    accountState.emailAccountId = "account-a";
    queryState.initialChatId = "chat-1";
    queryState.initial = {};
    queryState.set = {};
    chatState.status = "streaming";
    chatState.messages = [
      { id: "user-message", role: "user" },
      { id: "stream-1", role: "assistant" },
    ];
    setVisibility("visible");
    mockUseSWRConfig.mockReturnValue({ mutate: vi.fn() });
    mockUseChatMessages.mockReturnValue({
      data: { messages: [], activeStreamId: null },
    });
    mockConvertToUIMessages.mockReturnValue([]);
    mockClientLoggerFlush.mockResolvedValue(undefined);
    mockChatStop.mockResolvedValue(undefined);
    mockResumeStream.mockResolvedValue(undefined);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
  });

  it("stops the run on the server before stopping the local stream", async () => {
    let latestContext: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latestContext = useChat();
      return null;
    }
    renderWithProvider(<Consumer />);

    await act(async () => {
      await latestContext?.stop();
    });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledWith("/api/chat/chat-1/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [EMAIL_ACCOUNT_HEADER]: "account-a",
      },
      body: JSON.stringify({ activeStreamId: "stream-1" }),
    });
    expect(fetchMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockChatStop.mock.invocationCallOrder[0],
    );
  });

  it("reattaches when the tab returns after the connection dropped mid-reply", async () => {
    renderWithProvider(<div />);

    setVisibility("hidden");
    act(() => {
      chatState.onError?.(new TypeError("Load failed"));
    });
    expect(mockResumeStream).not.toHaveBeenCalled();
    expect(mockToastError).not.toHaveBeenCalled();

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mockResumeStream).toHaveBeenCalledTimes(1);
  });

  it("reattaches when a backgrounded tab's stream stalled", async () => {
    renderWithProvider(<div />);

    await hideAndShowTab();

    expect(mockChatStop).toHaveBeenCalled();
    expect(mockResumeStream).toHaveBeenCalledTimes(1);
  });

  it("leaves a stream alone that kept updating in the background", async () => {
    const { rerender } = renderWithProvider(<div />);

    setVisibility("hidden");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    chatState.messages = [...chatState.messages];
    rerender(
      <ChatProvider>
        <div />
      </ChatProvider>,
    );
    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(mockResumeStream).not.toHaveBeenCalled();
  });

  it("reattaches to a reply still running when the chat is opened", async () => {
    chatState.status = "ready";
    chatState.messages = [];
    mockUseChatMessages.mockReturnValue({
      data: { messages: [], activeStreamId: "stream-1" },
    });

    await act(async () => {
      renderWithProvider(<div />);
    });

    expect(mockResumeStream).toHaveBeenCalledTimes(1);
  });

  // The server keeps no copy of a streaming reply (RD-3), so a dropped reply
  // can't be reattached; the chat says it is finishing and checks back.
  it("says a dropped reply is finishing and checks back until it is saved", async () => {
    vi.useFakeTimers();
    const mutate = vi.fn();
    mockUseSWRConfig.mockReturnValue({ mutate });
    chatState.status = "error";
    chatState.messages = [
      { id: "question", role: "user" },
      { id: "stream-1", role: "assistant" },
    ];
    let running = true;
    mockUseChatMessages.mockImplementation(() => ({
      data: {
        messages: [],
        activeStreamId: running ? "stream-1" : null,
        activeStreamStartedAt: running ? new Date().toISOString() : null,
      },
    }));
    let latest: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latest = useChat();
      return null;
    }

    try {
      const { rerender } = renderWithProvider(<Consumer />);
      expect(latest?.replyFinishing).toBe(true);
      // The partial reply stays on screen until the whole one is saved.
      expect(mockSetMessages).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(mutate).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/chats\//),
      );

      running = false;
      rerender(
        <ChatProvider>
          <Consumer />
        </ChatProvider>,
      );
      expect(latest?.replyFinishing).toBe(false);
      expect(mockSetMessages).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  // A run whose instance died never clears its marker, and the refetched
  // chat is the same each time, so the wait ends on the clock.
  it("stops waiting for a reply once its run is past the chat route's limit", async () => {
    vi.useFakeTimers();
    const mutate = vi.fn();
    mockUseSWRConfig.mockReturnValue({ mutate });
    chatState.status = "error";
    chatState.messages = [{ id: "stream-1", role: "assistant" }];
    const data = {
      messages: [],
      activeStreamId: "stream-1",
      activeStreamStartedAt: new Date().toISOString(),
    };
    mockUseChatMessages.mockReturnValue({ data });
    let latest: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latest = useChat();
      return null;
    }

    try {
      renderWithProvider(<Consumer />);
      expect(latest?.replyFinishing).toBe(true);

      await act(async () => {
        vi.advanceTimersByTime(301_000);
      });
      expect(latest?.replyFinishing).toBe(false);
      const polls = mutate.mock.calls.length;
      await act(async () => {
        vi.advanceTimersByTime(30_000);
      });
      expect(mutate.mock.calls.length).toBe(polls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't check back while the tab is hidden", async () => {
    vi.useFakeTimers();
    const mutate = vi.fn();
    mockUseSWRConfig.mockReturnValue({ mutate });
    chatState.status = "error";
    chatState.messages = [{ id: "stream-1", role: "assistant" }];
    mockUseChatMessages.mockReturnValue({
      data: {
        messages: [],
        activeStreamId: "stream-1",
        activeStreamStartedAt: new Date().toISOString(),
      },
    });
    setVisibility("hidden");

    try {
      renderWithProvider(<div />);
      await act(async () => {
        vi.advanceTimersByTime(10_000);
      });
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't say a reply is finishing once its run is too old to be alive", () => {
    mockUseChatMessages.mockReturnValue({
      data: {
        messages: [],
        activeStreamId: "stream-1",
        activeStreamStartedAt: new Date(Date.now() - 600_000).toISOString(),
      },
    });
    let latest: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latest = useChat();
      return null;
    }

    renderWithProvider(<Consumer />);

    expect(latest?.replyFinishing).toBe(false);
  });

  it("does not reattach after an explicit stop", async () => {
    let latestContext: ReturnType<typeof useChat> | undefined;
    function Consumer() {
      latestContext = useChat();
      return null;
    }
    renderWithProvider(<Consumer />);

    await act(async () => {
      await latestContext?.stop();
    });
    await hideAndShowTab();

    expect(mockResumeStream).not.toHaveBeenCalled();
  });
});

describe("ChatProvider across accounts", () => {
  let latestContext: ReturnType<typeof useChat> | undefined;

  function Consumer() {
    latestContext = useChat();
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    latestContext = undefined;
    accountState.emailAccountId = "account-a";
    accountState.disconnectedA = null;
    accountState.disconnectedB = null;
    accountState.accountsLoading = false;
    accountState.accountsError = undefined;
    accountState.accountsWithoutB = false;
    accountState.keepDataOnError = false;
    queryState.initialChatId = null;
    queryState.initial = {};
    queryState.set = {};
    chatState.id = "new-chat-id";
    chatState.status = "ready";
    chatState.messages = [];
    setVisibility("visible");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null)));
    mockUseSWRConfig.mockReturnValue({ mutate: vi.fn() });
    mockUseChatMessages.mockReturnValue({ data: undefined });
    mockConvertToUIMessages.mockReturnValue([]);
    mockSendMessage.mockResolvedValue(undefined);
  });

  afterEach(() => {
    getDefaultStore().set(openThreadAtom, null);
  });

  it("works in the account the chat belongs to", () => {
    renderWithProvider(<Consumer />);

    expect(latestContext?.chatAccount).toMatchObject({
      id: "account-a",
      email: "a@example.com",
    });
    expect(latestContext?.switchedAccount).toBe(false);
  });

  it("keeps the chat where it is when a thread from another account opens, and names the thread with its account", async () => {
    getDefaultStore().set(openThreadAtom, {
      emailAccountId: "account-b",
      threadId: "t-b",
      messageId: "m-b",
    });
    renderWithProvider(<Consumer />);

    expect(latestContext?.chatAccount?.id).toBe("account-a");
    expect(latestContext?.switchedAccount).toBe(false);
    const body = await sendThroughTransport();
    expect(body.headers[EMAIL_ACCOUNT_HEADER.toLowerCase()]).toBe("account-a");
    expect(body.json.openThreadId).toBe("acct:account-b:t-b");
    expect(body.json.openMessageId).toBe("acct:account-b:m-b");
  });

  it("keeps a conversation under way when another account's thread opens", async () => {
    queryState.initialChatId = "chat-from-a";
    chatState.messages = [{ id: "m1", role: "user" }];
    renderWithProvider(<Consumer />);
    mockSetMessages.mockClear();

    act(() => {
      getDefaultStore().set(openThreadAtom, {
        emailAccountId: "account-b",
        threadId: "t-b",
      });
    });

    expect(latestContext?.chatAccount?.id).toBe("account-a");
    expect(latestContext?.chatId).toBe("chat-from-a");
    expect(mockSetMessages).not.toHaveBeenCalledWith([]);
  });

  it("runs a saved chat in the account that holds it, from any of the user's pages", async () => {
    queryState.initialChatId = "chat-from-b";
    mockUseChatMessages.mockReturnValue({
      data: { emailAccountId: "account-b", messages: [] },
    });
    renderWithProvider(<Consumer />);

    expect(mockUseChatMessages).toHaveBeenLastCalledWith("chat-from-b");
    expect(latestContext?.chatAccount?.id).toBe("account-b");
    expect(latestContext?.switchedAccount).toBe(true);
    const body = await sendThroughTransport();
    expect(body.headers[EMAIL_ACCOUNT_HEADER.toLowerCase()]).toBe("account-b");
  });

  it("opens a chat from the history in the account that holds it, before its messages load", async () => {
    renderWithProvider(<Consumer />);

    act(() =>
      latestContext?.openChat({
        id: "chat-from-b",
        emailAccountId: "account-b",
      }),
    );

    expect(latestContext?.chatId).toBe("chat-from-b");
    expect(latestContext?.chatAccount?.id).toBe("account-b");
    const body = await sendThroughTransport();
    expect(body.headers[EMAIL_ACCOUNT_HEADER.toLowerCase()]).toBe("account-b");
  });

  it("uses the page's account for a chat held by an account the user no longer has", () => {
    accountState.accountsWithoutB = true;
    queryState.initialChatId = "chat-from-b";
    mockUseChatMessages.mockReturnValue({
      data: { emailAccountId: "someone-elses-account", messages: [] },
    });
    renderWithProvider(<Consumer />);

    expect(latestContext?.chatAccount?.id).toBe("account-a");
  });

  it("keeps the chat and reports the error when the accounts list can't load", () => {
    accountState.accountsError = new Error("Failed to fetch");
    queryState.initialChatId = "chat-from-b";
    mockUseChatMessages.mockReturnValue({
      data: { emailAccountId: "account-b", messages: [] },
    });
    renderWithProvider(<Consumer />);

    expect(latestContext?.switchedAccount).toBe(true);
    expect(latestContext?.chatId).toBe("chat-from-b");
    expect(latestContext?.chatAccountError).toBe(accountState.accountsError);
  });

  it("goes back to the page's account when the page's account changes", async () => {
    const { rerender } = renderWithProvider(<Consumer />);
    act(() =>
      latestContext?.openChat({
        id: "chat-from-b",
        emailAccountId: "account-b",
      }),
    );
    expect(latestContext?.chatAccount?.id).toBe("account-b");

    accountState.emailAccountId = "account-a2";
    rerender(
      <ChatProvider>
        <Consumer />
      </ChatProvider>,
    );

    await waitFor(() => expect(latestContext?.chatId).toBeNull());
  });

  it("keeps sending while any of the user's accounts is connected", async () => {
    accountState.disconnectedB = "2026-09-01T00:00:00.000Z";
    renderWithProvider(<Consumer />);
    act(() =>
      latestContext?.openChat({
        id: "chat-from-b",
        emailAccountId: "account-b",
      }),
    );

    await act(async () => {
      await latestContext?.submitTextMessage("Archive this");
    });
    expect(mockSendMessage).toHaveBeenCalled();
  });

  it("does not send once every account is disconnected", async () => {
    accountState.disconnectedA = "2026-09-01T00:00:00.000Z";
    accountState.disconnectedB = "2026-09-01T00:00:00.000Z";
    renderWithProvider(<Consumer />);
    act(() =>
      latestContext?.openChat({
        id: "chat-from-b",
        emailAccountId: "account-b",
      }),
    );

    let sendError: unknown;
    await act(async () => {
      await latestContext?.submitTextMessage("Archive this").catch((error) => {
        sendError = error;
      });
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect((sendError as Error).message).toBe(
      "Reconnect b@example.com to continue",
    );
  });
});

async function sendThroughTransport() {
  const transport = mockChatTransport.mock.results.at(-1)
    ?.value as DefaultChatTransport<ChatMessage>;
  vi.mocked(fetch).mockResolvedValueOnce(new Response("data: [DONE]\n\n"));
  await transport.sendMessages({
    trigger: "submit-message",
    chatId: "chat-1",
    messageId: undefined,
    abortSignal: undefined,
    messages: [
      {
        id: "user-message",
        role: "user",
        parts: [{ type: "text", text: "Summarize this" }],
      },
    ],
  });
  const [, request] = vi.mocked(fetch).mock.calls.at(-1)!;
  return {
    headers: Object.fromEntries(new Headers(request?.headers).entries()),
    json: JSON.parse(request?.body as string),
  };
}

async function hideAndShowTab() {
  setVisibility("hidden");
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  setVisibility("visible");
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
}

function renderWithProvider(children: React.ReactNode) {
  return render(<ChatProvider>{children}</ChatProvider>);
}

function buildFixRuleContext(threadId: string): MessageContext {
  return {
    type: "fix-rule",
    message: {
      id: `message-${threadId}`,
      threadId,
      snippet: "Example message",
      textPlain: "Example message body",
      headers: {
        from: "sender@example.com",
        to: "recipient@example.com",
        subject: "Example subject",
        date: "2026-07-31T10:00:00.000Z",
      },
    },
    results: [],
    expected: "none",
  };
}
