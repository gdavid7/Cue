import { asSchema, type ModelMessage, type Tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getEmailAccount } from "@/__tests__/helpers";
import { aiProcessAssistantChat } from "@/utils/ai/assistant/chat";
import {
  CHAT_PROMPT_TOKEN_LIMIT,
  fitPromptToBudget,
  OMITTED_HISTORY_NOTE,
} from "@/utils/ai/assistant/chat-prompt-budget";
import {
  estimateMessageTokens,
  estimateTextTokens,
} from "@/utils/ai/assistant/prompt-size";
import { toolCallAgentStream } from "@/utils/llms";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/llms", () => ({ toolCallAgentStream: vi.fn() }));
vi.mock("@/utils/integration-action.server", () => ({
  isIntegrationActionEnabledForUserId: async () => false,
}));
vi.mock("@/utils/attachments/save-to-drive", () => ({
  getConnectedDriveApps: async () => [],
}));
vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => true,
  searchExa: vi.fn(),
}));
vi.mock("@/utils/calendar/event-provider", () => ({
  hasUsableCalendarConnection: async () => true,
  createCalendarEventProviders: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/gmail/quota", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/gmail/quota")>()),
  holdGmailInteractiveDemand: vi.fn(async () => ({
    held: true,
    release: async () => {},
  })),
}));

const anthropicModel = { provider: "anthropic.messages", modelId: "claude" };

describe("fitPromptToBudget", () => {
  it("leaves a prompt that fits unchanged", () => {
    const messages = conversation(2);

    const result = fitPromptToBudget({
      messages,
      fixedTokens: 1000,
      historyEndIndex: messages.length - 2,
    });

    expect(result.messages).toBe(messages);
    expect(result.stage).toBeUndefined();
  });

  it("shortens earlier tool results before dropping any conversation", () => {
    const messages = conversation(3);
    const budgetTokens =
      estimateMessageTokens(messages) - estimateTextTokens("x".repeat(10_000));

    const result = fitPromptToBudget({
      messages,
      fixedTokens: 0,
      historyEndIndex: messages.length - 2,
      budgetTokens,
    });

    expect(result.stage).toBe("shortened_earlier_results");
    expect(result.messages).toHaveLength(messages.length);
    expect(result.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
  });

  it("drops the oldest whole turns, keeping each tool call with its result", () => {
    const messages = conversation(6);
    const historyEndIndex = messages.length - 2;

    const result = fitPromptToBudget({
      messages,
      fixedTokens: 0,
      historyEndIndex,
      budgetTokens: 2500,
    });

    expect(result.stage).toBe("dropped_history");
    expect(result.messages[0]).toBe(messages[0]);
    expect(result.messages[1]).toEqual({
      role: "user",
      content: OMITTED_HISTORY_NOTE,
    });
    expect(result.messages[2].role).toBe("user");
    expect(result.messages.at(-1)).toBe(messages.at(-1));
    expect(result.historyEndIndex).toBe(result.messages.length - 2);
    expectToolCallsAnswered(result.messages);
    expect(result.estimatedTokens).toBeLessThanOrEqual(2500);
  });

  it("adds no second note when a later step drops more history", () => {
    const messages = conversation(6);
    const first = fitPromptToBudget({
      messages,
      fixedTokens: 0,
      historyEndIndex: messages.length - 2,
      budgetTokens: 2500,
    });

    const second = fitPromptToBudget({
      messages: first.messages,
      fixedTokens: 0,
      historyEndIndex: first.historyEndIndex,
      budgetTokens: 1500,
    });

    expect(
      second.messages.filter((m) => m.content === OMITTED_HISTORY_NOTE),
    ).toHaveLength(1);
    expectToolCallsAnswered(second.messages);
  });

  it("holds the budget when the latest tool results alone are too large", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "system" },
      { role: "user", content: "read all of these" },
      ...toolRound("readAttachment", "x".repeat(400_000)),
    ];

    const result = fitPromptToBudget({
      messages,
      fixedTokens: 0,
      historyEndIndex: 0,
      budgetTokens: 2000,
    });

    expect(result.estimatedTokens).toBeLessThanOrEqual(2000);
    expect(result.messages).toHaveLength(messages.length);
    expectToolCallsAnswered(result.messages);
  });
});

describe("assistant chat prompt size", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(toolCallAgentStream).mockResolvedValue({} as never);
  });

  it("keeps a typical follow-up turn small at every step", async () => {
    const steps = await runTurn({
      history: realisticHistory(3),
      latestUserText: "anything from Acme about the contract?",
      toolRounds: [
        [
          searchInboxResult("acme contract"),
          searchInboxResult("from:acme.example"),
        ],
        [readEmailResult()],
      ],
    });

    // Tool definitions and the system prompt alone were about 35K before the
    // rule schemas were flattened; earlier turns' results are shortened.
    expect(steps[0].fixedTokens).toBeLessThan(23_000);
    for (const step of steps) {
      expect(step.estimatedTokens).toBeLessThan(45_000);
    }
  });

  it("keeps a long chat with large tool results under the prompt limit", async () => {
    const steps = await runTurn({
      history: realisticHistory(40),
      latestUserText: "summarize every attachment from this week",
      toolRounds: Array.from({ length: 5 }, () => [
        readAttachmentResult(),
        readAttachmentResult(),
        searchInboxResult("has:attachment newer_than:7d"),
      ]),
    });

    for (const step of steps) {
      expect(step.estimatedTokens).toBeLessThan(CHAT_PROMPT_TOKEN_LIMIT);
      // Anthropic allows four, and the last tool definition holds one.
      expect(step.cacheBreakpoints).toBeLessThanOrEqual(3);
    }
  });
});

// Runs aiProcessAssistantChat and replays its tool loop through prepareStep,
// returning each step's estimated prompt size, tool definitions included.
async function runTurn({
  history,
  latestUserText,
  toolRounds,
}: {
  history: ModelMessage[];
  latestUserText: string;
  toolRounds: ToolRoundResult[][];
}) {
  await aiProcessAssistantChat({
    messages: [...history, { role: "user", content: latestUserText }],
    emailAccountId: "email-account-id",
    user: getEmailAccount(),
    isFirstUserTurn: false,
    supportsInlineEmailCards: true,
    logger: createTestLogger(),
  });
  const [options] = vi.mocked(toolCallAgentStream).mock.calls[0];
  const toolTokens = await toolDefinitionTokens(
    options.tools as Record<string, Tool>,
  );

  let messages = options.messages as ModelMessage[];
  const steps: Array<{
    estimatedTokens: number;
    fixedTokens: number;
    cacheBreakpoints: number;
  }> = [];
  for (let stepNumber = 0; stepNumber <= toolRounds.length; stepNumber++) {
    const prepared = await options.prepareStep?.({
      messages,
      stepNumber,
      steps: [],
      model: anthropicModel,
    } as never);
    messages = (prepared?.messages as ModelMessage[] | undefined) ?? messages;
    steps.push({
      estimatedTokens: toolTokens + estimateMessageTokens(messages),
      fixedTokens: toolTokens + estimateMessageTokens(messages.slice(0, 1)),
      cacheBreakpoints: messages.filter(
        (message) => message.providerOptions?.anthropic?.cacheControl,
      ).length,
    });

    const round = toolRounds[stepNumber];
    if (round)
      messages = [...messages, ...toolRoundMessages(round, stepNumber)];
  }
  return steps;
}

async function toolDefinitionTokens(tools: Record<string, Tool>) {
  const definitions = await Promise.all(
    Object.entries(tools).map(async ([name, definition]) =>
      JSON.stringify({
        name,
        description: definition.description,
        input_schema: await asSchema(definition.inputSchema).jsonSchema,
      }),
    ),
  );
  return estimateTextTokens(definitions.join(""));
}

type ToolRoundResult = { toolName: string; input: unknown; output: unknown };

function toolRoundMessages(
  results: ToolRoundResult[],
  round: number,
): ModelMessage[] {
  const ids = results.map((_, index) => `call-${round}-${index}`);
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: "Checking your inbox." },
        ...results.map((result, index) => ({
          type: "tool-call" as const,
          toolCallId: ids[index],
          toolName: result.toolName,
          input: result.input,
        })),
      ],
    },
    {
      role: "tool",
      content: results.map((result, index) => ({
        type: "tool-result" as const,
        toolCallId: ids[index],
        toolName: result.toolName,
        output: { type: "json" as const, value: result.output as never },
      })),
    },
  ];
}

// Earlier turns as the chat route rebuilds them from stored messages: a
// search, a read, and an answer with inline email cards.
function realisticHistory(turns: number): ModelMessage[] {
  return Array.from({ length: turns }, (_, turn) => [
    { role: "user" as const, content: `what came in today? (${turn})` },
    ...toolRoundMessages(
      [searchInboxResult(`newer_than:1d ${turn}`), readEmailResult()],
      100 + turn,
    ),
    { role: "assistant" as const, content: inboxSummaryAnswer() },
  ]).flat();
}

function searchInboxResult(query: string): ToolRoundResult {
  const messages = Array.from({ length: 20 }, (_, index) => ({
    messageId: `18c${index.toString(16).padStart(13, "0")}`,
    threadId: `18c${index.toString(16).padStart(13, "1")}`,
    externalUrl: `https://mail.google.com/mail/u/0/#all/18c${index}`,
    subject: `Quarterly vendor update number ${index}: pricing and timeline changes`,
    from: `Vendor Team ${index} <updates${index}@vendor-${index}.example>`,
    to: "user@test.example",
    snippet:
      "Hi there, following up on the proposal we sent last week with the revised pricing for the next quarter and the updated delivery timeline. Let us know",
    date: "Tue, 14 Oct 2026 09:12:44 +0000",
    labelNames: ["UNREAD", "IMPORTANT", "CATEGORY_UPDATES", "INBOX"],
    category: "fyi",
    isUnread: true,
    hasAttachments: index % 5 === 0,
  }));
  return {
    toolName: "searchInbox",
    input: { query },
    output: {
      queryUsed: query,
      totalReturned: messages.length,
      nextPageToken: "token",
      hasMore: true,
      summary: {
        total: 20,
        unread: 20,
        byCategory: {
          to_reply: 0,
          awaiting_reply: 0,
          fyi: 20,
          actioned: 0,
          uncategorized: 0,
        },
      },
      messages,
    },
  };
}

function readEmailResult(): ToolRoundResult {
  return {
    toolName: "readEmail",
    input: { messageId: "18c0000000000001" },
    output: {
      messageId: "18c0000000000001",
      threadId: "18c1111111111111",
      from: "Vendor Team <updates@vendor.example>",
      to: "user@test.example",
      subject: "Contract renewal",
      date: "Tue, 14 Oct 2026 09:12:44 +0000",
      content: "The renewal terms are attached. ".repeat(125),
      attachments: [],
    },
  };
}

function readAttachmentResult(): ToolRoundResult {
  return {
    toolName: "readAttachment",
    input: { messageId: "18c0000000000001", attachmentId: "a1" },
    output: {
      filename: "report.pdf",
      text: "Quarterly figures and commentary. ".repeat(235),
      truncated: true,
    },
  };
}

function inboxSummaryAnswer() {
  const cards = Array.from(
    { length: 8 },
    (_, index) =>
      `<email index="${index + 1}" threadid="18c${index}">Vendor ${index} sent revised pricing for next quarter and a new delivery date.</email>`,
  ).join("\n");
  return `## Must handle now\n<emails>\n${cards}\n</emails>\n\nWant me to archive the rest?`;
}

function conversation(turns: number): ModelMessage[] {
  return [
    { role: "system", content: "system" },
    ...Array.from({ length: turns }, (_, turn) => [
      { role: "user" as const, content: `question ${turn}` },
      ...toolRound("searchInbox", "x".repeat(10_000), `t${turn}`),
      { role: "assistant" as const, content: `answer ${turn}` },
    ]).flat(),
    { role: "user", content: "latest question" },
  ];
}

function toolRound(
  toolName: string,
  text: string,
  id = "latest",
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: id, toolName, input: { id } }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: id,
          toolName,
          output: { type: "json", value: { text } },
        },
      ],
    },
  ];
}

function expectToolCallsAnswered(messages: ModelMessage[]) {
  const callIds = messages.flatMap((message) =>
    message.role === "assistant" && Array.isArray(message.content)
      ? message.content.flatMap((part) =>
          part.type === "tool-call" ? [part.toolCallId] : [],
        )
      : [],
  );
  const resultIds = messages.flatMap((message) =>
    message.role === "tool"
      ? message.content.flatMap((part) =>
          part.type === "tool-result" ? [part.toolCallId] : [],
        )
      : [],
  );
  expect(new Set(resultIds)).toEqual(new Set(callIds));
}
