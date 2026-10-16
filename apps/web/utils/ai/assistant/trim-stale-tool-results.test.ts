import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import {
  projectEarlierTurnToolResults,
  RECENT_TOOL_RESULTS_TO_KEEP,
  trimStaleToolResults,
} from "@/utils/ai/assistant/trim-stale-tool-results";

describe("trimStaleToolResults", () => {
  it("leaves conversations under the budget untouched", () => {
    const messages = [
      userMessage("Clean up my inbox"),
      ...searchRound(0, { snippetLength: 100 }),
    ];

    expect(trimStaleToolResults(messages)).toBe(messages);
  });

  it("keeps identifiers from stale search results and drops bulky fields", () => {
    const messages = buildLargeTurn();

    const trimmed = trimStaleToolResults(messages);

    const firstSearch = getToolOutputValue(trimmed, "call-0");
    expect(firstSearch).toMatchObject({
      queryUsed: "query 0",
      exactCount: 47,
      countError: "Exact message count unavailable",
      nextPageToken: "page-token-0",
      messages: [
        {
          messageId: "message-0",
          threadId: "thread-0",
          subject: "Subject 0",
          from: "sender-0@example.com",
        },
      ],
    });
    expect(JSON.stringify(firstSearch)).not.toContain("snippet-0");
    expect(JSON.stringify(firstSearch)).not.toContain("https://");
  });

  it("keeps the most recent tool results intact", () => {
    const messages = buildLargeTurn();
    const lastCallId = `call-${TURN_ROUNDS - 1}`;

    const trimmed = trimStaleToolResults(messages);

    expect(getToolOutputValue(trimmed, lastCallId)).toEqual(
      getToolOutputValue(messages, lastCallId),
    );
  });

  it("shortens stale email content but keeps attachment identifiers", () => {
    const messages = [
      userMessage("What did the contract say?"),
      ...readEmailRound("read-0", "c".repeat(4000)),
      ...buildLargeTurn(),
    ];

    const trimmed = trimStaleToolResults(messages);
    const readResult = getToolOutputValue(trimmed, "read-0") as {
      content: string;
      attachments: Array<{ attachmentId: string }>;
    };

    expect(readResult.content.length).toBeLessThan(1000);
    expect(readResult.attachments).toEqual([
      { attachmentId: "attachment-1", filename: "contract.pdf" },
    ]);
  });

  it("does not trim again until enough new results accumulate", () => {
    const largeConversationHistory = userMessage("h".repeat(600_000));
    const once = trimStaleToolResults([
      largeConversationHistory,
      ...buildLargeTurn(),
    ]);
    const withNewResults = [
      ...once,
      ...searchRound(TURN_ROUNDS, { snippetLength: 3000 }),
      ...searchRound(TURN_ROUNDS + 1, { snippetLength: 3000 }),
    ];

    expect(trimStaleToolResults(withNewResults)).toBe(withNewResults);
  });

  it("does not count results it cannot shorten toward the budget", () => {
    const largeUntrimmableResult: ModelMessage = {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "list-0",
          toolName: "listThreadIds",
          output: {
            type: "json",
            value: Array.from({ length: 20_000 }, (_, index) => `id-${index}`),
          },
        },
      ],
    };
    const messages = [
      userMessage("Clean up my inbox"),
      largeUntrimmableResult,
      ...Array.from({ length: RECENT_TOOL_RESULTS_TO_KEEP + 1 }, (_, index) =>
        searchRound(index, { snippetLength: 100 }),
      ).flat(),
    ];

    expect(trimStaleToolResults(messages)).toBe(messages);
  });

  it("leaves small stale results unchanged", () => {
    const messages = [
      userMessage("Clean up my inbox"),
      ...moveRound("move-0"),
      ...buildLargeTurn(),
    ];

    const trimmed = trimStaleToolResults(messages);

    expect(getToolOutputValue(trimmed, "move-0")).toEqual({
      success: true,
      movedCount: 1,
    });
  });
});

describe("trimStaleToolResults write sources", () => {
  it.each([
    "getUserRulesAndSettings",
    "getLearnedPatterns",
    "getAssistantCapabilities",
  ])("never shortens a stale %s result, since a later write can save it back", (toolName) => {
    const messages = [
      userMessage("Show my rules, then clean up"),
      ...toolRound(toolName, "settings-0", {
        personalInstructions: "p".repeat(2000),
        rules: [{ name: "Newsletters", aiInstructions: "a".repeat(1500) }],
      }),
      ...buildLargeTurn(),
    ];

    const trimmed = trimStaleToolResults(messages);

    expect(getToolOutputValue(trimmed, "call-0")).toHaveProperty(
      "trimmedForContext",
    );
    expect(getToolOutputValue(trimmed, "settings-0")).toEqual(
      getToolOutputValue(messages, "settings-0"),
    );
  });
});

describe("projectEarlierTurnToolResults", () => {
  it("replays earlier turns' searches in the model's view and leaves the latest turn alone", () => {
    const messages = [
      userMessage("What's new?"),
      ...searchRound(0, { snippetLength: 20 }),
      userMessage("And from Acme?"),
      ...searchRound(1, { snippetLength: 20 }),
    ];

    const projected = projectEarlierTurnToolResults(messages);

    const [earlier] = (
      getToolOutputValue(projected, "call-0") as {
        messages: Array<Record<string, unknown>>;
      }
    ).messages;
    expect(earlier).toMatchObject({
      messageId: "message-0",
      threadId: "thread-0",
      subject: "Subject 0",
    });
    expect(earlier).not.toHaveProperty("externalUrl");
    expect(earlier).not.toHaveProperty("hasAttachments");
    expect(getToolOutputValue(projected, "call-1")).toEqual(
      getToolOutputValue(messages, "call-1"),
    );
  });

  it("shortens earlier turns' large results however little output there is", () => {
    const messages = [
      userMessage("What did the contract say?"),
      ...readEmailRound("read-0", "c".repeat(4000)),
      ...searchRound(0, { snippetLength: 3000 }),
      ...moveRound("move-0"),
      userMessage("And the latest one?"),
      ...readEmailRound("read-1", "d".repeat(4000)),
    ];

    const projected = projectEarlierTurnToolResults(messages);

    const earlierRead = getToolOutputValue(projected, "read-0") as {
      content: string;
      attachments: unknown;
      trimmedForContext?: string;
    };
    expect(earlierRead.content.length).toBeLessThan(1000);
    expect(earlierRead.attachments).toEqual([
      { attachmentId: "attachment-1", filename: "contract.pdf" },
    ]);
    expect(earlierRead.trimmedForContext).toBeDefined();
    const earlierSearch = getToolOutputValue(projected, "call-0");
    expect(earlierSearch).toMatchObject({
      nextPageToken: "page-token-0",
      messages: [{ messageId: "message-0", threadId: "thread-0" }],
    });
    expect(JSON.stringify(earlierSearch)).not.toContain("snippet-0");
    expect(getToolOutputValue(projected, "move-0")).toEqual({
      success: true,
      movedCount: 1,
    });
    expect(getToolOutputValue(projected, "read-1")).toEqual(
      getToolOutputValue(messages, "read-1"),
    );
  });

  it.each([
    "getUserRulesAndSettings",
    "getLearnedPatterns",
    "getAssistantCapabilities",
  ])("keeps earlier turns' %s results whole, since a later write can save them back", (toolName) => {
    const messages = [
      userMessage("Show my rules"),
      ...toolRound(toolName, "settings-0", {
        personalInstructions: "p".repeat(2000),
        rules: [{ name: "Newsletters", aiInstructions: "a".repeat(1500) }],
      }),
      userMessage("Now make the newsletter rule archive too"),
    ];

    const projected = projectEarlierTurnToolResults(messages);

    expect(getToolOutputValue(projected, "settings-0")).toEqual(
      getToolOutputValue(messages, "settings-0"),
    );
  });
});

const TURN_ROUNDS = RECENT_TOOL_RESULTS_TO_KEEP + 150;

function buildLargeTurn(): ModelMessage[] {
  return [
    userMessage("Move every newsletter into the Newsletters folder"),
    ...Array.from({ length: TURN_ROUNDS }, (_, index) =>
      searchRound(index, { snippetLength: 3000 }),
    ).flat(),
  ];
}

function userMessage(content: string): ModelMessage {
  return { role: "user", content };
}

function searchRound(
  index: number,
  { snippetLength }: { snippetLength: number },
): ModelMessage[] {
  const callId = `call-${index}`;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "searchInbox",
          input: { query: `query ${index}` },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "searchInbox",
          output: {
            type: "json",
            value: {
              queryUsed: `query ${index}`,
              totalReturned: 1,
              exactCount: 47,
              countError: "Exact message count unavailable",
              nextPageToken: `page-token-${index}`,
              hasMore: true,
              summary: { total: 1 },
              messages: [
                {
                  messageId: `message-${index}`,
                  threadId: `thread-${index}`,
                  externalUrl: `https://mail.example.com/${index}`,
                  subject: `Subject ${index}`,
                  from: `sender-${index}@example.com`,
                  to: "user@example.com",
                  snippet: `snippet-${index} ${"s".repeat(snippetLength)}`,
                  date: "2026-09-25T10:00:00.000Z",
                  labelNames: ["Newsletter"],
                  category: "fyi",
                  isUnread: true,
                  hasAttachments: false,
                },
              ],
            },
          },
        },
      ],
    },
  ];
}

function toolRound(
  toolName: string,
  callId: string,
  value: Record<string, unknown>,
): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool-call", toolCallId: callId, toolName, input: {} }],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName,
          output: { type: "json", value: value as never },
        },
      ],
    },
  ];
}

function moveRound(callId: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "moveThreadsToFolder",
          input: { threadIds: ["thread-0"], folderName: "Projects" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "moveThreadsToFolder",
          output: { type: "json", value: { success: true, movedCount: 1 } },
        },
      ],
    },
  ];
}

function readEmailRound(callId: string, content: string): ModelMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: callId,
          toolName: "readEmail",
          input: { messageId: "message-read" },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: callId,
          toolName: "readEmail",
          output: {
            type: "json",
            value: {
              messageId: "message-read",
              threadId: "thread-read",
              externalUrl: "https://mail.example.com/read",
              from: "legal@example.com",
              to: "user@example.com",
              subject: "Contract",
              content,
              date: "2026-09-25T10:00:00.000Z",
              attachments: [
                { attachmentId: "attachment-1", filename: "contract.pdf" },
              ],
            },
          },
        },
      ],
    },
  ];
}

function getToolOutputValue(messages: ModelMessage[], toolCallId: string) {
  for (const message of messages) {
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type === "tool-result" && part.toolCallId === toolCallId) {
        return "value" in part.output ? part.output.value : undefined;
      }
    }
  }
}
