import { asSchema, type ModelMessage, type Tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogger,
  getEmailAccount,
  getMockMessage,
} from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { toOtherAccountEmailId } from "@/utils/ai/assistant/other-account-email-id";
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

describe("aiProcessAssistantChat tool definitions", () => {
  async function chatTools() {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's new?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
    });
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
    return Object.entries(options.tools as Record<string, Tool>);
  }

  it("caches the tool definitions separately from the per-turn system prompt", async () => {
    const tools = await chatTools();
    const cached = tools.filter(
      ([, definition]) => definition.providerOptions?.anthropic?.cacheControl,
    );

    expect(cached.map(([name]) => name)).toEqual([tools.at(-1)?.[0]]);
    expect(cached[0][1].providerOptions?.anthropic?.cacheControl).toEqual({
      type: "ephemeral",
    });
  });

  it("gives every tool a flat object input schema", async () => {
    const tools = await chatTools();

    for (const [name, definition] of tools) {
      const schema = (await asSchema(definition.inputSchema).jsonSchema) as {
        type?: unknown;
        anyOf?: unknown;
        oneOf?: unknown;
        allOf?: unknown;
      };
      expect(schema.type, name).toBe("object");
      expect(
        schema.anyOf ?? schema.oneOf ?? schema.allOf,
        name,
      ).toBeUndefined();
    }
  });
});

describe("aiProcessAssistantChat across accounts", () => {
  async function chatTools() {
    let tools: Record<string, Tool> = {};
    vi.mocked(toolCallAgentStream).mockImplementation(async (options) => {
      tools = options.tools as Record<string, Tool>;
      return {} as never;
    });
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "archive the Acme email" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
    });
    return tools;
  }

  it("refuses to change another account's email from this chat", async () => {
    const { createEmailProvider } = await import("@/utils/email/provider");
    vi.mocked(createEmailProvider).mockClear();
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "other-account",
        email: "other@example.com",
        name: null,
        image: null,
        account: { provider: "google" },
      },
    ] as never);
    const tools = await chatTools();

    const result = await tools.manageInbox.execute?.(
      {
        action: "archive_threads",
        threadIds: [toOtherAccountEmailId("other-account", "thread-1")],
      },
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(result).toMatchObject({
      error: expect.stringContaining("other@example.com"),
    });
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("reads another account's email in that account", async () => {
    const { createEmailProvider } = await import("@/utils/email/provider");
    vi.mocked(createEmailProvider).mockReset();
    vi.mocked(createEmailProvider).mockResolvedValue({
      getMessage: vi.fn(async () => getMockMessage({ id: "message-1" })),
    } as never);
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "other-account",
        email: "other@example.com",
        name: null,
        image: null,
        account: { provider: "google" },
      },
    ] as never);
    const tools = await chatTools();

    const result = await tools.readEmail.execute?.(
      { messageId: toOtherAccountEmailId("other-account", "message-1") },
      { toolCallId: "call-1", messages: [] } as never,
    );

    expect(createEmailProvider).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "other-account" }),
    );
    expect(result).toMatchObject({ account: "other@example.com" });
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

describe("aiProcessAssistantChat current time", () => {
  async function modelMessagesAt(time: string) {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(time));
    try {
      vi.mocked(toolCallAgentStream).mockClear();
      vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
      await aiProcessAssistantChat({
        messages: [{ role: "user", content: "what came in today?" }],
        emailAccountId: "email-account-id",
        user: getEmailAccount(),
        logger: createTestLogger(),
      });
    } finally {
      vi.useRealTimers();
    }
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
    return options.messages as ModelMessage[];
  }

  it("keeps the system prompt identical across turns at different times", async () => {
    const morning = await modelMessagesAt("2026-10-16T08:00:00.000Z");
    const evening = await modelMessagesAt("2026-10-16T19:30:12.345Z");

    const systemOf = (messages: ModelMessage[]) =>
      messages.filter((message) => message.role === "system");
    expect(systemOf(morning)).toHaveLength(1);
    expect(systemOf(evening)).toEqual(systemOf(morning));
    expect(JSON.stringify(systemOf(evening))).not.toContain("2026-10-16");
  });

  it("gives the current time as the first automated context message", async () => {
    const messages = await modelMessagesAt("2026-10-16T19:30:12.345Z");
    const [, firstContext] = messages;

    expect(firstContext).toEqual({
      role: "user",
      content:
        "[Automated context — not a message from the user] Current timestamp: 2026-10-16T19:30:12.345Z.",
    });
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

  it("keeps the reasoning settings of a model without a thinking level", async () => {
    const step = await prepareStepFor();

    const result = await step(1, {
      provider: "openai.responses",
      modelId: "gpt-6-luna",
    });

    expect(result?.providerOptions).toBeUndefined();
  });

  it("lowers Claude's effort while it can still call tools", async () => {
    const step = await prepareStepFor();

    expect(await step(1, CLAUDE_STEP_MODEL)).toMatchObject({
      providerOptions: { anthropic: { effort: "low" } },
    });
    expect(await step(6, CLAUDE_STEP_MODEL)).not.toHaveProperty(
      "providerOptions",
    );
  });

  it("keeps Claude's and Gemini's tool definitions when it forces the answer", async () => {
    const step = await prepareStepFor();

    for (const model of [CLAUDE_STEP_MODEL, GEMINI_STEP_MODEL]) {
      const forced = await step(6, model);

      expect(forced, model.provider).toMatchObject({ toolChoice: "none" });
      expect(forced, model.provider).not.toHaveProperty("activeTools");
    }
  });

  it("moves Claude's fourth cache breakpoint to the end of each step's prompt", async () => {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    await aiProcessAssistantChat({
      messages: [
        { role: "user", content: "what's new?" },
        { role: "assistant", content: "Two newsletters." },
        { role: "user", content: "and from Acme?" },
      ],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      logger: createTestLogger(),
    });
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
    const toolBreakpoints = Object.values(
      options.tools as Record<string, Tool>,
    ).filter((tool) => tool.providerOptions?.anthropic?.cacheControl).length;

    let messages = options.messages as ModelMessage[];
    for (let stepNumber = 0; stepNumber < 4; stepNumber++) {
      const prepared = await options.prepareStep!({
        stepNumber,
        steps: [],
        messages,
        model: CLAUDE_STEP_MODEL,
      } as never);
      // The AI SDK carries a step's prepared messages into the next step.
      messages = [
        ...(prepared?.messages ?? messages),
        ...toolRound(`call-${stepNumber}`),
      ];
      const stepPrompt = prepared?.messages ?? [];
      const breakpoints = stepPrompt.flatMap((message, index) =>
        message.providerOptions?.anthropic?.cacheControl ? [index] : [],
      );

      expect(toolBreakpoints + breakpoints.length).toBeLessThanOrEqual(4);
      expect(breakpoints).toContain(stepPrompt.length - 1);
      expect(breakpoints).toContain(0);
    }
  });

  it("drops the tools of other providers when it forces the answer", async () => {
    const step = await prepareStepFor();

    expect(
      await step(6, { provider: "openai.responses", modelId: "gpt-6-luna" }),
    ).toMatchObject({ activeTools: [], toolChoice: "none" });
  });

  it("answers without more tools after six steps", async () => {
    const step = await prepareStepFor();

    expect(await step(5)).not.toMatchObject({ toolChoice: "none" });
    expect(await step(6)).toMatchObject({ toolChoice: "none" });
  });

  it("caps Slack, Teams and Telegram turns at six tool steps too", async () => {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
    await aiProcessAssistantChat({
      messages: [{ role: "user", content: "what's new?" }],
      emailAccountId: "email-account-id",
      user: getEmailAccount(),
      responseSurface: "messaging",
      messagingPlatform: "slack",
      logger: createTestLogger(),
    });
    const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];

    expect(
      await options.prepareStep!({
        stepNumber: 6,
        steps: [],
        messages: [{ role: "user", content: "what's new?" }],
        model: {
          provider: "google.generative-ai",
          modelId: "gemini-3.8-flash",
        },
      } as never),
    ).toMatchObject({ toolChoice: "none" });
  });

  it("answers without more tools once a web turn has spent 45 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const step = await prepareStepFor();
      vi.setSystemTime(Date.now() + 44_000);
      expect(await step(1)).not.toMatchObject({ toolChoice: "none" });
      vi.setSystemTime(Date.now() + 2000);
      expect(await step(1)).toMatchObject({ toolChoice: "none" });
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

const CLAUDE_STEP_MODEL = {
  provider: "anthropic.messages",
  modelId: "claude-sonnet-5-5",
};

const GEMINI_STEP_MODEL = {
  provider: "google.generative-ai",
  modelId: "gemini-3.8-flash",
};

function toolRound(toolCallId: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "searchInbox",
          input: { query: "from:acme" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "searchInbox",
          output: { type: "json", value: { messages: [] } },
        },
      ],
    },
  ];
}
