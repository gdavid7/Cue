import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import type { EmailProvider } from "@/utils/email/types";
import {
  findConfirmedPreview,
  runMatchingQueryAction,
  toMatchingBulkAction,
} from "./chat-matching-actions";

const { mockStartMatchingBulkJob } = vi.hoisted(() => ({
  mockStartMatchingBulkJob: vi.fn(async () => "job-1"),
}));
vi.mock("@/utils/mail-bulk/start-matching-job", () => ({
  startMatchingBulkJob: mockStartMatchingBulkJob,
}));

const ACCOUNT = "account-1";
const QUERY = "category:promotions after:2025/01/01 before:2026/01/01";
const archive = { originalAction: "archive_threads", query: QUERY };
const logger = createTestLogger();

describe("toMatchingBulkAction", () => {
  it("runs archive, read state and labels as the inbox's select-all actions", () => {
    expect(toMatchingBulkAction("archive_threads", undefined)).toBe("archive");
    expect(toMatchingBulkAction("mark_read_threads", true)).toBe("mark_read");
    expect(toMatchingBulkAction("mark_read_threads", false)).toBe(
      "mark_unread",
    );
    expect(toMatchingBulkAction("label_threads", undefined)).toBe("label");
    // Trash has no confirm-and-undo flow here, so it never runs over a search.
    expect(toMatchingBulkAction("trash_threads", undefined)).toBeNull();
  });
});

describe("findConfirmedPreview", () => {
  it("finds a preview of the same request that the user has answered since", () => {
    expect(
      findConfirmedPreview(
        [
          user("Archive all newsletters from last year"),
          ...preview({ action: "archive_threads", query: QUERY }),
          assistant("That's 1,204 conversations. Archive them?"),
          user("yes"),
        ],
        archive,
      ),
    ).toEqual({ conversations: 1204 });
  });

  // Production rebuilds each turn's history from the stored chat messages.
  it("finds the preview in history rebuilt from stored chat messages", async () => {
    const stored: UIMessage[] = [
      {
        id: "1",
        role: "user",
        parts: [
          { type: "text", text: "Archive all newsletters from last year" },
        ],
      },
      {
        id: "2",
        role: "assistant",
        parts: [
          {
            type: "tool-manageInbox",
            toolCallId: "call-stored",
            state: "output-available",
            input: { action: "archive_threads", query: QUERY },
            output: { status: "needs_confirmation", conversations: 1204 },
          },
          { type: "text", text: "That's 1,204 conversations. Archive them?" },
        ],
      },
      { id: "3", role: "user", parts: [{ type: "text", text: "yes" }] },
    ];

    expect(
      findConfirmedPreview(await convertToModelMessages(stored), archive),
    ).toEqual({ conversations: 1204 });
  });

  it("doesn't count a preview from this turn, which the user hasn't seen", () => {
    expect(
      findConfirmedPreview(
        [
          user("Archive all newsletters from last year"),
          ...preview({ action: "archive_threads", query: QUERY }),
        ],
        archive,
      ),
    ).toBeNull();
  });

  it("doesn't count a preview of a different search, action or label", () => {
    const answered = (input: Record<string, unknown>) => [
      user("Archive all newsletters from last year"),
      ...preview(input),
      user("yes"),
    ];
    expect(
      findConfirmedPreview(
        answered({ action: "archive_threads", query: "category:promotions" }),
        archive,
      ),
    ).toBeNull();
    expect(
      findConfirmedPreview(
        answered({ action: "mark_read_threads", query: QUERY, read: true }),
        archive,
      ),
    ).toBeNull();
    expect(
      findConfirmedPreview(
        answered({ action: "label_threads", query: QUERY, labelName: "Old" }),
        { originalAction: "label_threads", query: QUERY, labelName: "Older" },
      ),
    ).toBeNull();
  });

  it("doesn't count a call that found nothing to change", () => {
    expect(
      findConfirmedPreview(
        [
          ...preview(
            { action: "archive_threads", query: QUERY },
            { status: "nothing_to_change", conversations: 0 },
          ),
          user("archive them anyway"),
        ],
        archive,
      ),
    ).toBeNull();
  });
});

describe("runMatchingQueryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("only counts what archiving would change until the user confirms", async () => {
    const provider = listingProvider(30);

    const result = await runMatchingQueryAction({
      request: archive,
      bulkAction: "archive",
      emailProvider: provider,
      emailAccountId: ACCOUNT,
      messages: [user("Archive all newsletters from last year")],
      logger,
    });

    // Archiving lists only what is still in the inbox, as the job will.
    expect(provider.listMatchingMessages).toHaveBeenCalledWith({
      scope: { q: QUERY },
      only: { inInbox: true },
      pageToken: undefined,
    });
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "needs_confirmation",
      action: "archive_threads",
      query: QUERY,
      conversations: 15,
      messages: 30,
    });
  });

  it("starts the select-all job in the chat's account once the user confirmed the count", async () => {
    const provider = listingProvider(30);

    const result = await runMatchingQueryAction({
      request: archive,
      bulkAction: "archive",
      emailProvider: provider,
      emailAccountId: ACCOUNT,
      messages: [
        user("Archive all newsletters from last year"),
        ...preview({ action: "archive_threads", query: QUERY }),
        user("yes, do it"),
      ],
      logger,
    });

    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
    expect(mockStartMatchingBulkJob).toHaveBeenCalledWith({
      emailAccountId: ACCOUNT,
      scope: { q: QUERY },
      action: "archive",
      labelId: undefined,
      logger,
    });
    expect(result).toEqual({
      status: "started",
      action: "archive_threads",
      query: QUERY,
      jobId: "job-1",
      conversations: 1204,
    });
  });

  it("says there is nothing to change rather than asking about zero conversations", async () => {
    const result = await runMatchingQueryAction({
      request: archive,
      bulkAction: "archive",
      emailProvider: listingProvider(0),
      emailAccountId: ACCOUNT,
      messages: [user("Archive all newsletters from last year")],
      logger,
    });
    expect(result).toMatchObject({ status: "nothing_to_change" });
  });
});

function user(content: string): ModelMessage {
  return { role: "user", content };
}

function assistant(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

let callCount = 0;

function preview(
  input: Record<string, unknown>,
  output: Record<string, unknown> = {
    status: "needs_confirmation",
    conversations: 1204,
    messages: 2210,
  },
): ModelMessage[] {
  const toolCallId = `call-${callCount++}`;
  return [
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId, toolName: "manageInbox", input },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "manageInbox",
          output: { type: "json", value: output as never },
        },
      ],
    },
  ];
}

/** A provider listing `total` messages, two per conversation. */
function listingProvider(total: number) {
  return {
    listMatchingMessages: vi.fn(async () => ({
      messages: Array.from({ length: total }, (_, index) => ({
        id: `m-${index}`,
        threadId: `t-${Math.floor(index / 2)}`,
      })),
    })),
  } as unknown as EmailProvider & {
    listMatchingMessages: ReturnType<typeof vi.fn>;
  };
}
