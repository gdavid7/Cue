import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OutlookClient } from "@/utils/outlook/client";
import { createTestLogger } from "@/__tests__/helpers";
import { getProviderRateLimitDelayMs } from "@/utils/email/rate-limit";
import {
  getMessagesInBatches,
  getThreadParticipantMessagesInBatches,
  moveMessagesForSenders,
  moveThreadsInBatches,
} from "./batch";

const mockGetFolderIds = vi.fn();
const mockUpdateEmailMessagesForSender = vi.fn();
const mockPublishBulkActionToTinybird = vi.fn();

vi.mock("@/utils/outlook/message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/outlook/message")>()),
  getFolderIds: (...args: Parameters<typeof mockGetFolderIds>) =>
    mockGetFolderIds(...args),
}));

vi.mock("@/utils/email/bulk-action-tracking", () => ({
  updateEmailMessagesForSender: (
    ...args: Parameters<typeof mockUpdateEmailMessagesForSender>
  ) => mockUpdateEmailMessagesForSender(...args),
  publishBulkActionToTinybird: (
    ...args: Parameters<typeof mockPublishBulkActionToTinybird>
  ) => mockPublishBulkActionToTinybird(...args),
}));

describe("getThreadParticipantMessagesInBatches", () => {
  it("preserves successful participants without continuing after throttling", async () => {
    const batchPost = vi.fn().mockResolvedValue({
      responses: [
        { id: "thread-0", status: 429 },
        {
          id: "thread-1",
          status: 200,
          body: {
            value: [{ id: "message-1" }],
            "@odata.nextLink":
              "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next",
          },
        },
      ],
    });
    const result = await getThreadParticipantMessagesInBatches({
      client: createMockOutlookClient({
        listMessages: async () => ({ value: [] }),
        batchPost,
      }),
      threadIds: Array.from(
        { length: 21 },
        (_, index) => `conversation-${index}`,
      ),
      logger: createTestLogger(),
    });
    expect(batchPost).toHaveBeenCalledTimes(1);
    expect(result.get("conversation-1")).toEqual([{ id: "message-1" }]);
    expect(result.has("conversation-0")).toBe(false);
    expect(result.has("conversation-20")).toBe(false);
  });

  it("filters by conversation and follows continuation pages", async () => {
    const nextLink =
      "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=next-page";
    const batchPost = vi.fn(
      async (body: {
        requests: Array<{ id: string; url: string; method: string }>;
      }) => {
        const request = body.requests.at(0);
        if (!request) throw new Error("Expected participant batch request");

        if (batchPost.mock.calls.length === 1) {
          const requestUrl = new URL(
            request.url,
            "https://graph.microsoft.com",
          );
          expect(requestUrl.searchParams.get("$filter")).toBe(
            "conversationId eq 'thread-1' and isDraft eq false",
          );

          return {
            responses: [
              {
                id: request.id,
                status: 200,
                body: {
                  value: [{ id: "message-1" }],
                  "@odata.nextLink": nextLink,
                },
              },
            ],
          };
        }

        expect(request.url).toBe("/me/messages?$skiptoken=next-page");
        return {
          responses: [
            {
              id: request.id,
              status: 200,
              body: { value: [{ id: "message-2" }] },
            },
          ],
        };
      },
    );
    const client = createMockOutlookClient({
      listMessages: async () => ({ value: [] }),
      batchPost,
    });

    const result = await getThreadParticipantMessagesInBatches({
      client,
      threadIds: ["thread-1"],
      logger: createTestLogger(),
    });

    expect(batchPost).toHaveBeenCalledTimes(2);
    expect(result.get("thread-1")?.map((message) => message.id)).toEqual([
      "message-1",
      "message-2",
    ]);
  });
});

describe("moveMessagesForSenders", () => {
  beforeEach(() => {
    mockGetFolderIds.mockReset();
    mockUpdateEmailMessagesForSender.mockReset();
    mockPublishBulkActionToTinybird.mockReset();
  });

  it("tracks successful Outlook message moves before surfacing a partial batch failure", async () => {
    mockGetFolderIds.mockResolvedValue({
      inbox: "inbox-folder-id",
    });

    const client = createMockOutlookClient({
      listMessages: async () => ({
        value: [
          { id: "message-1", conversationId: "thread-1" },
          { id: "message-2", conversationId: "thread-2" },
        ],
      }),
      batchPost: async () => ({
        responses: [
          { id: "archive-0", status: 201, body: {} },
          {
            id: "archive-1",
            status: 429,
            body: { error: { message: "Rate limited" } },
          },
        ],
      }),
    });

    await expect(
      moveMessagesForSenders({
        client,
        senders: ["sender@example.com"],
        destinationId: "archive",
        action: "archive",
        ownerEmail: "owner@example.com",
        emailAccountId: "account-1",
        continueOnError: false,
        logger: createTestLogger(),
      }),
    ).rejects.toThrow("Graph batch returned one or more error responses.");

    expect(mockUpdateEmailMessagesForSender).toHaveBeenCalledWith({
      sender: "sender@example.com",
      messageIds: ["message-1"],
      emailAccountId: "account-1",
      action: "archive",
    });
    expect(mockPublishBulkActionToTinybird).toHaveBeenCalledWith({
      threadIds: ["thread-1"],
      action: "archive",
      ownerEmail: "owner@example.com",
    });
  });

  it("moves Outlook messages in small batches to avoid mailbox concurrency throttling", async () => {
    const messages = Array.from({ length: 9 }, (_, index) => ({
      id: `message-${index + 1}`,
      conversationId: `thread-${index + 1}`,
    }));
    const batchPost = vi.fn(
      async (body: {
        requests: Array<{ id: string; url: string; method: string }>;
      }) => ({
        responses: body.requests.map((request) => ({
          id: request.id,
          status: 201,
          body: {},
        })),
      }),
    );
    const client = createMockOutlookClient({
      listMessages: async () => ({
        value: messages,
      }),
      batchPost,
    });

    const movedCount = await moveMessagesForSenders({
      client,
      senders: ["sender@example.com"],
      destinationId: "deleteditems",
      action: "trash",
      ownerEmail: "owner@example.com",
      emailAccountId: "account-1",
      logger: createTestLogger(),
    });

    expect(movedCount).toBe(9);
    expect(batchPost).toHaveBeenCalledTimes(3);
    expect(batchPost.mock.calls.map(([body]) => body.requests.length)).toEqual([
      4, 4, 1,
    ]);
    expect(mockUpdateEmailMessagesForSender).toHaveBeenCalledWith({
      sender: "sender@example.com",
      messageIds: messages.map((message) => message.id),
      emailAccountId: "account-1",
      action: "trash",
    });
  });
});

describe("moveThreadsInBatches", () => {
  beforeEach(() => {
    mockPublishBulkActionToTinybird.mockReset();
  });

  it("returns thread-level results from Outlook batch responses", async () => {
    const client = createMockOutlookClient({
      listMessages: async () => ({ value: [] }),
      batchPost: async () => ({
        responses: [
          { id: "archive-0", status: 201, body: {} },
          {
            id: "archive-1",
            status: 429,
            body: { error: { message: "Rate limited" } },
          },
        ],
      }),
    });

    const result = await moveThreadsInBatches({
      client,
      threads: [
        { threadId: "thread-1", messageIds: ["message-1"] },
        { threadId: "thread-2", messageIds: ["message-2"] },
      ],
      destinationId: "archive",
      ownerEmail: "owner@example.com",
      logger: createTestLogger(),
    });

    expect(result).toEqual({
      succeededThreadIds: ["thread-1"],
      failedThreadIds: ["thread-2"],
    });
    expect(mockPublishBulkActionToTinybird).toHaveBeenCalledWith({
      threadIds: ["thread-1"],
      action: "archive",
      ownerEmail: "owner@example.com",
    });
  });

  it("stops sending Outlook batches after a rate-limit response", async () => {
    const batchPost = vi.fn(
      async (body: {
        requests: Array<{ id: string; url: string; method: string }>;
      }) => ({
        responses: body.requests.map((request) => ({
          id: request.id,
          status: 429,
          body: { error: { message: "Rate limited" } },
        })),
      }),
    );
    const client = createMockOutlookClient({
      listMessages: async () => ({ value: [] }),
      batchPost,
    });
    const threads = Array.from({ length: 5 }, (_, index) => ({
      threadId: `thread-${index + 1}`,
      messageIds: [`message-${index + 1}`],
    }));

    const result = await moveThreadsInBatches({
      client,
      threads,
      destinationId: "archive",
      ownerEmail: "owner@example.com",
      logger: createTestLogger(),
    });

    expect(batchPost).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      succeededThreadIds: [],
      failedThreadIds: threads.map((thread) => thread.threadId),
    });
  });
});

describe("getMessagesInBatches", () => {
  beforeEach(() => {
    mockGetFolderIds.mockResolvedValue({ inbox: "inbox-folder" });
  });

  it("reads messages in $batch calls of at most four items, one call at a time", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const batchPost = vi.fn(async (body: { requests: BatchItem[] }) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      return {
        responses: body.requests.map((request) => ({
          id: request.id,
          status: 200,
          body: graphMessage(messageIdFromUrl(request.url)),
        })),
      };
    });
    const ids = Array.from({ length: 10 }, (_, index) => `message-${index}`);

    const messages = await getMessagesInBatches({
      client: createMessageBatchClient(batchPost),
      messageIds: ids,
      logger: createTestLogger(),
    });

    expect(messages.map((message) => message.id)).toEqual(ids);
    expect(messages[0]).toMatchObject({
      threadId: "conversation-message-0",
      textHtml: "<p>body of message-0</p>",
      labelIds: expect.arrayContaining(["INBOX"]),
    });
    expect(maxInFlight).toBe(1);
    const sizes = batchPost.mock.calls.map(([body]) => body.requests.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(4);
    const [item] = batchPost.mock.calls[0][0].requests;
    expect(item).toMatchObject({
      method: "GET",
      headers: { Prefer: 'IdType="ImmutableId"' },
    });
    const url = new URL(item.url, "https://graph.microsoft.com");
    expect(url.searchParams.get("$select")).toContain("body");
    expect(url.searchParams.get("$expand")).toContain("attachments");
  });

  it("leaves out messages Graph no longer has", async () => {
    const batchPost = vi.fn(async (body: { requests: BatchItem[] }) => ({
      responses: body.requests.map((request) => {
        const messageId = messageIdFromUrl(request.url);
        return messageId === "gone"
          ? {
              id: request.id,
              status: 404,
              body: { error: { code: "ErrorItemNotFound" } },
            }
          : { id: request.id, status: 200, body: graphMessage(messageId) };
      }),
    }));

    const messages = await getMessagesInBatches({
      client: createMessageBatchClient(batchPost),
      messageIds: ["a", "gone", "b"],
      logger: createTestLogger(),
    });

    expect(messages.map((message) => message.id)).toEqual(["a", "b"]);
  });

  it("retries only the items Graph throttled once Retry-After has passed", async () => {
    const throttledOnce = new Set(["b"]);
    const batchPost = vi.fn(async (body: { requests: BatchItem[] }) => ({
      responses: body.requests.map((request) => {
        const messageId = messageIdFromUrl(request.url);
        if (throttledOnce.delete(messageId)) {
          return {
            id: request.id,
            status: 429,
            headers: { "Retry-After": "0" },
            body: {
              error: {
                code: "ApplicationThrottled",
                message: "Application is over its MailboxConcurrency limit.",
              },
            },
          };
        }
        return { id: request.id, status: 200, body: graphMessage(messageId) };
      }),
    }));

    const messages = await getMessagesInBatches({
      client: createMessageBatchClient(batchPost),
      messageIds: ["a", "b", "c"],
      logger: createTestLogger(),
    });

    expect(messages.map((message) => message.id)).toEqual(["a", "b", "c"]);
    const requested = batchPost.mock.calls.flatMap(([body]) =>
      body.requests.map((request) => messageIdFromUrl(request.url)),
    );
    expect(requested).toEqual(["a", "b", "c", "b"]);
  });

  it("surfaces a throttled item as a Graph rate limit carrying its Retry-After", async () => {
    const batchPost = vi.fn(async (body: { requests: BatchItem[] }) => ({
      responses: body.requests.map((request) => ({
        id: request.id,
        status: 429,
        headers: { "Retry-After": "30" },
        body: { error: { code: "ApplicationThrottled", message: "Throttled" } },
      })),
    }));

    const error = await getMessagesInBatches({
      client: createMessageBatchClient(batchPost),
      messageIds: ["a"],
      logger: createTestLogger(),
    }).catch((caught: unknown) => caught);

    expect(
      getProviderRateLimitDelayMs({
        error,
        provider: "microsoft",
        attemptNumber: 1,
      }),
    ).toBe(30_000);
  });

  it("fails on an item error that is neither missing nor transient", async () => {
    const batchPost = vi.fn(async (body: { requests: BatchItem[] }) => ({
      responses: body.requests.map((request) => ({
        id: request.id,
        status: 403,
        body: { error: { code: "ErrorAccessDenied", message: "Denied" } },
      })),
    }));

    await expect(
      getMessagesInBatches({
        client: createMessageBatchClient(batchPost),
        messageIds: ["a"],
        logger: createTestLogger(),
      }),
    ).rejects.toMatchObject({ statusCode: 403, code: "ErrorAccessDenied" });
  });
});

type BatchItem = {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
};

function messageIdFromUrl(url: string) {
  return decodeURIComponent(
    new URL(url, "https://graph.microsoft.com").pathname.split("/").at(-1) ??
      "",
  );
}

function graphMessage(id: string) {
  return {
    id,
    conversationId: `conversation-${id}`,
    subject: `Subject ${id}`,
    receivedDateTime: "2026-10-15T10:00:00Z",
    parentFolderId: "inbox-folder",
    isDraft: false,
    isRead: true,
    from: { emailAddress: { address: "ada@example.com", name: "Ada" } },
    body: { contentType: "html", content: `<p>body of ${id}</p>` },
  };
}

function createMessageBatchClient(
  batchPost: (body: { requests: BatchItem[] }) => Promise<unknown>,
): OutlookClient {
  return {
    getClient: () => ({
      api: (path: string) => {
        if (path !== "/$batch") throw new Error(`Unexpected path ${path}`);
        return { post: batchPost };
      },
    }),
    getCategoryMapCache: () => new Map<string, string>(),
  } as unknown as OutlookClient;
}

function createMockOutlookClient({
  listMessages,
  batchPost,
}: {
  listMessages: () => Promise<{
    value: Array<{ id?: string | null; conversationId?: string | null }>;
    "@odata.nextLink"?: string;
  }>;
  batchPost: (body: unknown) => Promise<{
    responses: Array<{ id: string; status: number; body?: unknown }>;
  }>;
}): OutlookClient {
  const api = vi.fn((path: string) => {
    if (path === "/me/messages") {
      return {
        filter: () => ({
          top: () => ({
            select: () => ({
              get: listMessages,
            }),
          }),
        }),
      };
    }

    if (path === "/$batch") {
      return {
        post: batchPost,
      };
    }

    throw new Error(`Unexpected API path: ${path}`);
  });

  return {
    getClient: vi.fn(() => ({ api })),
  } as unknown as OutlookClient;
}
