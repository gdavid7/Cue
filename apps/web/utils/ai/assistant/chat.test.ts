import type { ModelMessage, Tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getEmailAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  aiProcessAssistantChat,
  buildInboxSnapshotMessage,
  buildResolvedSystemPrompt,
  loadFreshRuleContext,
} from "@/utils/ai/assistant/chat";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  admitGmailCall,
  currentGmailQuotaContext,
  holdGmailInteractiveDemand,
} from "@/utils/gmail/quota";
import { toolCallAgentStream } from "@/utils/llms";

const {
  mockIsIntegrationActionEnabledForUserId,
  mockGetConnectedDriveApps,
  mockHasUsableCalendarConnection,
} = vi.hoisted(() => ({
  mockIsIntegrationActionEnabledForUserId: vi.fn(async () => false),
  mockGetConnectedDriveApps: vi.fn(async () => []),
  mockHasUsableCalendarConnection: vi.fn(async () => true),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/llms", () => ({ toolCallAgentStream: vi.fn() }));
const { mockReleaseDemand } = vi.hoisted(() => ({
  mockReleaseDemand: vi.fn(async () => {}),
}));
vi.mock("@/utils/gmail/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/gmail/quota")>()),
  holdGmailInteractiveDemand: vi.fn(async () => mockReleaseDemand),
}));
vi.mock("@/utils/integration-action.server", () => ({
  isIntegrationActionEnabledForUserId: mockIsIntegrationActionEnabledForUserId,
}));
vi.mock("@/utils/attachments/save-to-drive", () => ({
  getConnectedDriveApps: mockGetConnectedDriveApps,
}));
vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => true,
  searchExa: vi.fn(),
}));
vi.mock("@/utils/calendar/event-provider", () => ({
  hasUsableCalendarConnection: mockHasUsableCalendarConnection,
  createCalendarEventProviders: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));

describe("buildResolvedSystemPrompt", () => {
  it("uses Outlook category wording instead of label wording", () => {
    const prompt = buildPrompt({ provider: "microsoft" });

    expect(prompt).toContain("category");
    expect(prompt).not.toMatch(/\blabels?\b/i);
  });

  it("adds a connect-calendar tip only when disconnection is confirmed", () => {
    const connectedPrompt = buildPrompt({
      calendarConnection: { state: "connected" },
    });
    const disconnectedPrompt = buildPrompt({
      calendarConnection: { state: "disconnected" },
    });
    const failedPrompt = buildPrompt({
      calendarConnection: { state: "failed", message: "Error: db down" },
    });

    for (const prompt of [connectedPrompt, disconnectedPrompt, failedPrompt]) {
      expect(prompt).toContain("calendar or inbox date-range tools");
    }
    expect(disconnectedPrompt).toContain(
      "you may tell them they can connect a calendar in settings",
    );
    expect(connectedPrompt).not.toContain("connect a calendar");
    expect(connectedPrompt).not.toContain(
      "Checking the calendar connection failed",
    );
    expect(failedPrompt).toContain(
      "Checking the calendar connection failed (Error: db down)",
    );
    expect(failedPrompt).toContain(
      "reconnect their calendar in settings or try again",
    );
    expect(failedPrompt).not.toContain(
      "you may tell them they can connect a calendar in settings",
    );
  });

  it("only asks for inline email card markup when the client can render it", () => {
    const cardPrompt = buildPrompt({ supportsInlineEmailCards: true });
    const plainPrompt = buildPrompt({ supportsInlineEmailCards: false });

    expect(cardPrompt).toContain("<emails>");
    expect(cardPrompt).toContain("<email-detail");

    expect(plainPrompt).not.toContain("<emails>");
    expect(plainPrompt).not.toContain("<email-detail");
    expect(plainPrompt).toContain("numbered list");
  });

  it("never asks for inline email card markup on messaging surfaces", () => {
    const prompt = buildPrompt({
      responseSurface: "messaging",
      supportsInlineEmailCards: true,
    });

    expect(prompt).not.toContain("<emails>");
    expect(prompt).not.toContain("<email-detail");
    expect(prompt).toBe(
      buildPrompt({
        responseSurface: "messaging",
        supportsInlineEmailCards: false,
      }),
    );
  });
});

describe("buildInboxSnapshotMessage", () => {
  it("frames the inbox snapshot as a starting point and not the live state", () => {
    const message = buildInboxSnapshotMessage({ total: 240, unread: 6 });

    expect(message).not.toBeNull();
    expect(message?.content).toContain("240");
    expect(message?.content).toContain("6");
    expect(message?.content).toMatch(/searchInbox/);
    expect(message?.content).toMatch(/stale|out of date|may have changed/i);
  });

  it("returns null when no inboxStats are available", () => {
    expect(buildInboxSnapshotMessage(null)).toBeNull();
    expect(buildInboxSnapshotMessage(undefined)).toBeNull();
  });
});

describe("loadFreshRuleContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockRuleSnapshot({ rulesRevision }: { rulesRevision: number }) {
    prisma.emailAccount.findUnique.mockResolvedValue({
      about: "Prefers short replies",
      rulesRevision,
      rules: [
        {
          name: "Newsletters",
          instructions: "Newsletters and digests",
          updatedAt: new Date("2026-07-01T00:00:00.000Z"),
          from: null,
          to: null,
          subject: null,
          conditionalOperator: "AND",
          enabled: true,
          runOnThreads: true,
          actions: [],
        },
      ],
      messagingChannels: [],
    } as any);
  }

  it("returns null for a brand-new chat that has never seen rules", async () => {
    const result = await loadFreshRuleContext({
      emailAccountId: "account-1",
      chatLastSeenRulesRevision: null,
      chatHasHistory: false,
    });

    expect(result).toBeNull();
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });

  it("hydrates read state without new rule state when the revision is unchanged", async () => {
    mockRuleSnapshot({ rulesRevision: 5 });

    const result = await loadFreshRuleContext({
      emailAccountId: "account-1",
      chatLastSeenRulesRevision: 5,
      chatHasHistory: true,
    });

    expect(result).not.toBeNull();
    expect(result?.hasNewRuleState).toBe(false);
    expect(result?.ruleReadState.rulesRevision).toBe(5);
    expect(result?.ruleReadState.ruleUpdatedAtByName.get("Newsletters")).toBe(
      "2026-07-01T00:00:00.000Z",
    );
  });

  it("marks new rule state when the revision advanced since the chat last saw it", async () => {
    mockRuleSnapshot({ rulesRevision: 6 });

    const result = await loadFreshRuleContext({
      emailAccountId: "account-1",
      chatLastSeenRulesRevision: 5,
      chatHasHistory: true,
    });

    expect(result?.hasNewRuleState).toBe(true);
    expect(result?.ruleReadState.rulesRevision).toBe(6);
  });

  it("marks new rule state for a chat with history that never saw a revision", async () => {
    mockRuleSnapshot({ rulesRevision: 0 });

    const result = await loadFreshRuleContext({
      emailAccountId: "account-1",
      chatLastSeenRulesRevision: null,
      chatHasHistory: true,
    });

    expect(result?.hasNewRuleState).toBe(true);
  });
});

function buildPrompt(
  overrides: Partial<Parameters<typeof buildResolvedSystemPrompt>[0]> = {},
) {
  return buildResolvedSystemPrompt({
    emailSendToolsEnabled: true,
    draftReplyActionsEnabled: true,
    webhookActionsEnabled: true,
    calendarConnection: { state: "connected" },
    provider: "google",
    responseSurface: "web",
    supportsInlineEmailCards: false,
    userTimezone: "UTC",
    currentTimestamp: "2026-05-12T00:00:00.000Z",
    ...overrides,
  });
}

describe("aiProcessAssistantChat tools", () => {
  it("run their provider calls as interactive Gmail traffic", async () => {
    const seen: Record<string, unknown> = {};
    const record = (tool: string) => () => {
      seen[tool] = currentGmailQuotaContext();
      throw new Error("stop after recording");
    };
    const { createEmailProvider } = await import("@/utils/email/provider");
    const { searchExa } = await import("@/utils/exa/search");
    const { createCalendarEventProviders } = await import(
      "@/utils/calendar/event-provider"
    );
    let currentTool = "";
    vi.mocked(createEmailProvider).mockImplementation(async () =>
      record(currentTool)(),
    );
    vi.mocked(searchExa).mockImplementation(async () => record("searchWeb")());
    vi.mocked(createCalendarEventProviders).mockImplementation(async () =>
      record("getCalendarEvents")(),
    );
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@test.com",
      timezone: "UTC",
    } as never);
    let tools: Record<string, Tool> = {};
    vi.mocked(toolCallAgentStream).mockImplementation(async (options) => {
      tools = options.tools as Record<string, Tool>;
      return {} as never;
    });

    await runWithAuditContext({ source: "chat" }, () =>
      aiProcessAssistantChat({
        messages: [{ role: "user", content: "what's new with Acme?" }],
        emailAccountId: "email-account-id",
        user: getEmailAccount(),
        logger: createTestLogger(),
      }),
    );

    const inputs: Record<string, unknown> = {
      searchInbox: { query: "acme" },
      searchContext: { query: "acme" },
      readEmail: { messageId: "message-1" },
      readAttachment: {
        messageId: "message-1",
        attachmentId: "attachment-1",
      },
      searchWeb: { query: "Acme Corp" },
      getCalendarEvents: {
        startDate: "2026-10-14T00:00:00Z",
        endDate: "2026-10-15T00:00:00Z",
      },
    };
    for (const [name, input] of Object.entries(inputs)) {
      currentTool = name;
      await tools[name].execute?.(input, {
        toolCallId: name,
        messages: [],
      } as never);
    }

    for (const name of Object.keys(inputs)) {
      expect(seen[name], name).toEqual(
        expect.objectContaining({
          caller: `chat/${name}`,
          priority: "interactive",
        }),
      );
    }
  });
});

describe("aiProcessAssistantChat setup", () => {
  it("runs its account lookups together before starting the model", async () => {
    vi.clearAllMocks();
    let finishIntegrationCheck: (enabled: boolean) => void = () => {};
    mockIsIntegrationActionEnabledForUserId.mockReturnValueOnce(
      new Promise<boolean>((resolve) => {
        finishIntegrationCheck = resolve;
      }),
    );
    vi.mocked(toolCallAgentStream).mockClear();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);

    const run = aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's new?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
    });

    await vi.waitFor(() => {
      expect(mockHasUsableCalendarConnection).toHaveBeenCalled();
      expect(mockGetConnectedDriveApps).toHaveBeenCalled();
    });
    expect(toolCallAgentStream).not.toHaveBeenCalled();

    finishIntegrationCheck(false);
    await run;

    expect(toolCallAgentStream).toHaveBeenCalledTimes(1);
  });
});

describe("aiProcessAssistantChat open thread", () => {
  async function modelMessagesFor(openThread?: {
    threadId: string;
    messageId?: string;
  }) {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's this about?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      openThread,
      logger: createTestLogger(),
    });
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
    return JSON.stringify(options.messages);
  }

  it("names the open thread and its latest message, and nothing more", async () => {
    const messages = await modelMessagesFor({
      threadId: "thread-42",
      messageId: "msg-7",
    });

    expect(messages).toContain(
      "[Automated context — not a message from the user] The user has this email open: threadId thread-42, latest messageId msg-7.",
    );
    // When to use the ids is the tools' to say.
    expect(messages).not.toContain("pass this threadId");
  });

  it("names just the thread when its messages aren't known", async () => {
    expect(await modelMessagesFor({ threadId: "thread-42" })).toContain(
      "The user has this email open: threadId thread-42.",
    );
  });

  it("says nothing about an open thread when none is open", async () => {
    expect(await modelMessagesFor()).not.toContain("has this email open");
  });
});

describe("aiProcessAssistantChat inbox snapshot", () => {
  it("follows the caller's first-turn flag rather than counting user-role messages", async () => {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    const snapshotFor = async (
      messages: ModelMessage[],
      isFirstUserTurn: boolean,
    ) => {
      vi.mocked(toolCallAgentStream).mockClear();
      await aiProcessAssistantChat({
        messages,
        emailAccountId: "email-account-id",
        user: getEmailAccount(),
        inboxStats: { total: 240, unread: 6 },
        isFirstUserTurn,
        logger: createTestLogger(),
      });
      const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
      return JSON.stringify(options.messages).includes(
        "Automated inbox snapshot",
      );
    };

    // A hidden inline-action message is also user-role, so a first turn can
    // carry two user messages.
    expect(
      await snapshotFor(
        [
          { role: "user", content: "archive these" },
          { role: "user", content: "Hidden inline action context" },
        ],
        true,
      ),
    ).toBe(true);
    expect(
      await snapshotFor([{ role: "user", content: "and now?" }], false),
    ).toBe(false);
  });
});

describe("aiProcessAssistantChat turn limits", () => {
  async function prepareStepFor() {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's new?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
    });
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
    const prepareStep = options.prepareStep!;
    return (
      stepNumber: number,
      model = { provider: "google.generative-ai", modelId: "gemini-3.8-flash" },
    ) =>
      prepareStep({
        stepNumber,
        steps: [],
        messages: [{ role: "user", content: "what's new?" }],
        model,
      } as never);
  }

  it("thinks briefly while it can still call tools and fully for the forced answer", async () => {
    const step = await prepareStepFor();
    const lowThinking = {
      providerOptions: { google: { thinkingConfig: { thinkingLevel: "low" } } },
    };

    expect(await step(0)).toMatchObject(lowThinking);
    expect(await step(5)).toMatchObject(lowThinking);
    expect(await step(6)).not.toHaveProperty("providerOptions");
  });

  it("keeps a non-Gemini model's own reasoning settings", async () => {
    const step = await prepareStepFor();

    const result = await step(1, {
      provider: "anthropic.messages",
      modelId: "claude-sonnet-5",
    });

    expect(result?.providerOptions).toBeUndefined();
  });

  it("answers without more tools after six steps", async () => {
    const step = await prepareStepFor();

    expect(await step(5)).not.toMatchObject({ toolChoice: "none" });
    expect(await step(6)).toMatchObject({
      activeTools: [],
      toolChoice: "none",
    });
  });

  it("answers without more tools once a web turn has spent 45 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const step = await prepareStepFor();
      vi.setSystemTime(Date.now() + 44_000);
      expect(await step(1)).not.toMatchObject({ toolChoice: "none" });
      vi.setSystemTime(Date.now() + 2000);
      expect(await step(1)).toMatchObject({
        activeTools: [],
        toolChoice: "none",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("aiProcessAssistantChat Gmail demand", () => {
  async function run() {
    vi.clearAllMocks();
    const { createEmailProvider } = await import("@/utils/email/provider");
    // Each tool's provider makes one Gmail call, then stops the tool.
    vi.mocked(createEmailProvider).mockImplementation(async () => {
      await admitGmailCall({ emailAccountId: "email-account-id", cost: 5 });
      throw new Error("stop after one Gmail call");
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@test.com",
      timezone: "UTC",
    } as never);
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    const cleanups: Array<() => void> = [];
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's new?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const options = vi.mocked(toolCallAgentStream).mock.calls[0][0];
    const tools = options.tools as Record<string, Tool>;
    const callGmailTool = () =>
      tools.readEmail.execute?.({ messageId: "message-1" }, {
        toolCallId: "call",
        messages: [],
      } as never);
    return { options, cleanups, callGmailTool };
  }

  it("holds nothing for a turn that never calls Gmail", async () => {
    const { options } = await run();

    await options.onEnd?.({} as never);

    expect(holdGmailInteractiveDemand).not.toHaveBeenCalled();
    expect(mockReleaseDemand).not.toHaveBeenCalled();
  });

  it("holds background work back from the first Gmail call, once, capped at the tool budget", async () => {
    const { callGmailTool } = await run();

    await callGmailTool();
    await callGmailTool();

    expect(holdGmailInteractiveDemand).toHaveBeenCalledTimes(1);
    expect(holdGmailInteractiveDemand).toHaveBeenCalledWith(
      "email-account-id",
      45_000,
    );
  });

  it("lets background work go once the turn ends", async () => {
    const { options, callGmailTool } = await run();
    await callGmailTool();

    await options.onEnd?.({} as never);

    await vi.waitFor(() => expect(mockReleaseDemand).toHaveBeenCalledTimes(1));
  });

  it("lets background work go once tools are switched off", async () => {
    const { options, callGmailTool } = await run();
    await callGmailTool();

    await options.prepareStep?.({
      stepNumber: 6,
      steps: [],
      messages: [],
      model: { provider: "google.generative-ai", modelId: "gemini-3.8-flash" },
    } as never);

    await vi.waitFor(() => expect(mockReleaseDemand).toHaveBeenCalledTimes(1));
  });

  it("lets background work go through the caller's cleanup when the stream fails", async () => {
    const { cleanups, callGmailTool } = await run();
    await callGmailTool();

    for (const cleanup of cleanups) cleanup();

    await vi.waitFor(() => expect(mockReleaseDemand).toHaveBeenCalledTimes(1));
  });
});
