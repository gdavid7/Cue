import type { Tool } from "ai";
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
import { currentGmailQuotaContext } from "@/utils/gmail/quota";
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
