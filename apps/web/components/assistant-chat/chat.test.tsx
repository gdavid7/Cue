/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmailAccountPreviewProvider } from "@/providers/EmailAccountProvider";
import { Chat } from "@/components/assistant-chat/chat";
import type { ChatHistoryEntry } from "@/components/assistant-chat/chat-history-types";
import type { Chat as ChatHelpers } from "@/providers/ChatProvider";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

const {
  mockCaptureAction,
  mockHandleSubmit,
  mockMutate,
  mockRegenerate,
  mockSetAttachments,
  mockSetChatId,
  mockSetContext,
  mockSetInput,
  mockUseChatInput,
  mockSetMessages,
  mockSetNewChat,
  mockStop,
  mockUseChats,
  chatState,
} = vi.hoisted(() => ({
  mockCaptureAction: vi.fn(),
  mockHandleSubmit: vi.fn(),
  mockMutate: vi.fn(),
  mockRegenerate: vi.fn(),
  mockSetAttachments: vi.fn(),
  mockSetChatId: vi.fn(),
  mockSetContext: vi.fn(),
  mockSetInput: vi.fn(),
  mockUseChatInput: vi.fn(),
  mockSetMessages: vi.fn(),
  mockSetNewChat: vi.fn(),
  mockStop: vi.fn(),
  mockUseChats: vi.fn(),
  chatState: {
    status: "ready" as ChatHelpers["status"],
    messages: [] as ChatHelpers["messages"],
  },
}));
const accountChat = vi.hoisted(() => ({
  chatAccount: {
    id: "email-account-1",
    email: "a@example.com",
    disconnected: false,
  } as { id: string; email: string; disconnected: boolean } | null,
  switchedAccount: false,
  openThreadAccountId: null as string | null,
  openChat: vi.fn(),
  switchChatAccount: vi.fn(),
}));

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [
        {
          id: "email-account-1",
          email: "a@example.com",
          account: { disconnectedAt: null },
        },
        {
          id: "email-account-2",
          email: "b@example.com",
          account: { disconnectedAt: null, provider: "google" },
          providerRateLimit: null,
        },
      ],
    },
  }),
}));

vi.mock("@/components/assistant-chat/messages", async () => {
  const { useAccount } = await vi.importActual<
    typeof import("@/providers/EmailAccountProvider")
  >("@/providers/EmailAccountProvider");
  return {
    // Names the account the messages' cards and actions would act in.
    Messages: ({ footer }: { footer?: React.ReactNode }) => (
      <div data-testid="messages">
        <span data-testid="messages-account">
          {useAccount().emailAccountId}
        </span>
        {footer}
      </div>
    ),
  };
});

vi.mock("@/components/assistant-chat/preview-attachment", () => ({
  PreviewAttachment: () => <div data-testid="preview-attachment" />,
}));

vi.mock("@/components/assistant-chat/RenameChatDialog", () => ({
  RenameChatDialog: () => null,
}));

vi.mock("@/components/assistant-chat/DeleteChatDialog", () => ({
  DeleteChatDialog: () => null,
}));

vi.mock("@/components/voice/VoiceInput", () => ({
  VoiceInput: () => null,
}));

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({
    execute: vi.fn(),
    isExecuting: false,
    result: undefined,
  }),
}));

vi.mock("@/utils/actions/chat", () => ({
  deleteChatAction: vi.fn(),
  renameChatAction: vi.fn(),
}));

vi.mock("@/utils/actions/safe-action", () => {
  function createActionClientMock() {
    const client = {
      bindArgsSchemas: () => client,
      use: () => client,
      metadata: () => client,
      inputSchema: () => client,
      action: vi.fn(),
    };

    return client;
  }

  return {
    actionClient: createActionClientMock(),
    actionClientUser: createActionClientMock(),
    adminActionClient: createActionClientMock(),
  };
});

vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInput: ({
    children,
    onSubmit,
  }: {
    children: React.ReactNode;
    onSubmit: React.FormEventHandler<HTMLFormElement>;
  }) => <form onSubmit={onSubmit}>{children}</form>,
  PromptInputTextarea: (
    props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
  ) => <textarea {...props} />,
  PromptInputSubmit: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { status: string }) => (
    <button type="submit" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("better-auth/react", () => ({
  createAuthClient: () => ({
    signIn: vi.fn(),
    signOut: vi.fn(),
    signUp: vi.fn(),
    useSession: () => ({
      data: { user: { name: "Barbara" } },
    }),
    getSession: vi.fn(),
    sso: {},
  }),
}));

vi.mock("@better-auth/sso/client", () => ({
  ssoClient: () => ({}),
}));

vi.mock("better-auth/client/plugins", () => ({
  genericOAuthClient: () => ({}),
  organizationClient: () => ({}),
}));

vi.mock("@/utils/prisma", () => ({
  default: {},
}));

vi.mock("@/hooks/useChats", () => ({
  useChats: (shouldFetch: boolean) => mockUseChats(shouldFetch),
}));

vi.mock("@/hooks/useProductAnalytics", () => ({
  useProductAnalytics: () => ({
    captureAction: mockCaptureAction,
  }),
}));

vi.mock("@/providers/ChatProvider", () => ({
  useChat: () => ({
    chat: {
      messages: chatState.messages,
      status: chatState.status,
      stop: vi.fn(),
      regenerate: mockRegenerate,
      setMessages: mockSetMessages,
      sendMessage: vi.fn(),
    } satisfies Partial<ChatHelpers>,
    chatId: null,
    ...mockUseChatInput(),
    persistedMessageIds: new Set(),
    handleSubmit: mockHandleSubmit,
    setNewChat: mockSetNewChat,
    context: null,
    setContext: mockSetContext,
    attachments: [],
    setAttachments: mockSetAttachments,
    setChatId: mockSetChatId,
    submitTextMessage: vi.fn(),
    stop: mockStop,
    ...accountChat,
  }),
}));

vi.mock("@/utils/auth-client", () => ({
  useSession: () => ({
    data: { user: { name: "Barbara" } },
  }),
}));

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  chatState.status = "ready";
  chatState.messages = [];
  accountChat.chatAccount = {
    id: "email-account-1",
    email: "a@example.com",
    disconnected: false,
  };
  accountChat.switchedAccount = false;
  accountChat.openThreadAccountId = null;
  window.localStorage.clear();
  mockUseChatInput.mockReturnValue({ input: "", setInput: mockSetInput });
});

describe("Chat history", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChats.mockImplementation((shouldFetch: boolean) => ({
      data: shouldFetch
        ? { chats: [chatHistoryEntry, otherAccountChat] }
        : undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    }));
  });

  it("loads previous chats when the history menu is opened without hover", async () => {
    render(<Chat open />);

    fireEvent.pointerDown(
      screen.getByRole("button", { name: /chat history/i }),
    );

    expect(await screen.findByText("Project update")).toBeTruthy();

    fireEvent.click(screen.getByText("Project update"));

    await waitFor(() => {
      expect(accountChat.openChat).toHaveBeenCalledWith({
        id: "chat-1",
        emailAccountId: "email-account-1",
      });
    });
  });

  it("lists every account's chats with the account each works in, and resumes one in its account", async () => {
    render(<Chat open />);
    fireEvent.pointerDown(
      screen.getByRole("button", { name: /chat history/i }),
    );

    const otherRow = (await screen.findByText("Travel plans")).closest(
      "[role=menuitem]",
    );
    expect(otherRow?.textContent).toContain("b@example.com");

    fireEvent.click(screen.getByText("Travel plans"));

    await waitFor(() =>
      expect(accountChat.openChat).toHaveBeenCalledWith({
        id: "chat-2",
        emailAccountId: "email-account-2",
      }),
    );
  });
});

describe("Chat account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChats.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it("names the account the chat works in", () => {
    render(<Chat open />);

    expect(screen.getByText("Chat for a@example.com")).toBeTruthy();
    expect(screen.queryByText(/Switched to/)).toBeNull();
  });

  it("says when it switched to another account for this conversation", () => {
    accountChat.chatAccount = {
      id: "email-account-2",
      email: "b@example.com",
      disconnected: false,
    };
    accountChat.switchedAccount = true;
    render(<Chat open />);

    expect(
      screen.getByText("Switched to b@example.com for this conversation"),
    ).toBeTruthy();
  });

  it("offers to move to the open email's account when a conversation is under way", () => {
    accountChat.openThreadAccountId = "email-account-2";
    render(<Chat open />);

    expect(screen.getByText("The open email is in b@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));

    expect(accountChat.switchChatAccount).toHaveBeenCalledWith(
      "email-account-2",
    );
  });

  it("runs the conversation's cards and actions in the chat's account", () => {
    accountChat.chatAccount = {
      id: "email-account-2",
      email: "b@example.com",
      disconnected: false,
    };
    chatState.messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "Hi" }] },
    ];
    render(
      <EmailAccountPreviewProvider>
        <Chat open />
      </EmailAccountPreviewProvider>,
    );

    expect(screen.getByTestId("messages-account").textContent).toBe(
      "email-account-2",
    );
  });

  it("keeps a disconnected account's chat read-only with a way to reconnect", () => {
    accountChat.chatAccount = {
      id: "email-account-2",
      email: "b@example.com",
      disconnected: true,
    };
    render(<Chat open />);

    expect(
      screen.getByText("Reconnect b@example.com to continue"),
    ).toBeTruthy();
    expect(
      (screen.getByTestId("chat-input") as HTMLTextAreaElement).disabled,
    ).toBe(true);
  });
});

describe("Chat input draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChats.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it("keeps up with a rapid burst of input and saves the draft", () => {
    mockUseChatInput.mockImplementation(() => {
      const [input, setInput] = React.useState("");
      return { input, setInput };
    });
    render(<Chat open />);
    const textarea = screen.getByTestId("chat-input") as HTMLTextAreaElement;
    const setNativeValue = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;

    // Outside act, React commits each controlled update synchronously, like a
    // text expander or dictation tool typing faster than React schedules work.
    // React's nested-update guard trips after 50 such updates, so a burst of
    // 100 still catches an extra render per keystroke at half the cost of 200.
    const burstLength = 100;
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      for (let i = 0; i < burstLength; i++) {
        setNativeValue?.call(textarea, `${textarea.value}x`);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } finally {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previous;
    }

    expect(textarea.value).toBe("x".repeat(burstLength));
    expect(window.localStorage.getItem("input")).toBe(
      JSON.stringify("x".repeat(burstLength)),
    );
  });

  it("restores a saved draft on mount", () => {
    window.localStorage.setItem("input", JSON.stringify("Saved draft"));
    render(<Chat open />);

    expect(mockSetInput).toHaveBeenCalledWith("Saved draft");
  });
});

describe("Chat stop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseChats.mockReturnValue({
      data: undefined,
      error: undefined,
      isLoading: false,
      mutate: mockMutate,
    });
  });

  it("stops the run on the server, not just the local stream", () => {
    chatState.status = "streaming";
    const { container } = render(<Chat open />);
    const submitButton = container.querySelector('button[type="submit"]');
    if (!submitButton) throw new Error("Submit button not found");
    fireEvent.click(submitButton);

    expect(mockStop).toHaveBeenCalledTimes(1);
  });
});

const chatHistoryEntry = {
  id: "chat-1",
  name: "Project update",
  createdAt: new Date("2026-05-23T00:00:00.000Z"),
  updatedAt: new Date("2026-05-23T00:00:00.000Z"),
  emailAccountId: "email-account-1",
  email: "a@example.com",
  disconnected: false,
} satisfies ChatHistoryEntry;

const otherAccountChat = {
  ...chatHistoryEntry,
  id: "chat-2",
  name: "Travel plans",
  emailAccountId: "email-account-2",
  email: "b@example.com",
} satisfies ChatHistoryEntry;
