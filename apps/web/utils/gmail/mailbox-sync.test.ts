import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import { encodeMailboxSyncCursor } from "@/utils/email/mailbox-sync";
import { getHistory } from "@/utils/gmail/history";
import {
  getGmailMailboxChangeIds,
  getGmailMailboxSyncPage,
} from "@/utils/gmail/mailbox-sync";
import {
  getMessage,
  getMessagesBatch,
  parseMessage,
} from "@/utils/gmail/message";

vi.mock("@/utils/gmail/history");
vi.mock("@/utils/gmail/message");

const logger = createTestLogger();

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getMessage).mockRejectedValue({ status: 404 });
});

describe("getGmailMailboxSyncPage", () => {
  it.each([
    "snapshot",
    "delta",
  ] as const)("does not advance %s sync when an omitted message is inaccessible", async (phase) => {
    const failure = { status: 403, message: "Permission denied" };
    vi.mocked(getMessage).mockRejectedValue(failure);
    vi.mocked(getMessagesBatch).mockResolvedValue([]);
    vi.mocked(getHistory).mockResolvedValue({
      history: [{ messagesAdded: [{ message: { id: "omitted" } }] }],
      historyId: "200",
    });
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: "100" } }),
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: "omitted" }], nextPageToken: "next" },
          }),
        },
      },
    };

    await expect(
      getGmailMailboxSyncPage({
        gmail: gmail as never,
        accessToken: "access-token",
        logger,
        after: new Date("2026-07-01T00:00:00.000Z"),
        cursor:
          phase === "delta"
            ? encodeMailboxSyncCursor({
                version: 1,
                provider: "google",
                phase: "delta",
                historyId: "100",
                after: "2026-07-01T00:00:00.000Z",
              })
            : undefined,
        limit: 100,
      }),
    ).rejects.toEqual(failure);
  });

  it("continues a snapshot when an omitted message is confirmed deleted", async () => {
    vi.mocked(getMessagesBatch).mockResolvedValue([]);
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: "100" } }),
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: "deleted" }], nextPageToken: "next" },
          }),
        },
      },
    };

    const page = await getGmailMailboxSyncPage({
      gmail: gmail as never,
      accessToken: "access-token",
      logger,
      after: new Date("2026-07-01T00:00:00.000Z"),
      limit: 100,
    });

    expect(getMessage).toHaveBeenCalledWith("deleted", gmail, "full");
    expect(page.upsertedMessages).toEqual([]);
    expect(page.hasMore).toBe(true);
  });

  it("recovers an omitted message instead of treating it as deleted", async () => {
    vi.mocked(getMessagesBatch).mockResolvedValue([]);
    vi.mocked(getHistory).mockResolvedValue({
      history: [{ messagesAdded: [{ message: { id: "omitted" } }] }],
      historyId: "200",
    });
    const message = {
      ...getMockMessage({ id: "omitted" }),
      internalDate: String(new Date("2026-07-02T00:00:00.000Z").getTime()),
    };
    vi.mocked(getMessage).mockResolvedValue({ id: "omitted" } as never);
    vi.mocked(parseMessage).mockReturnValue(message as never);

    const page = await getGmailMailboxSyncPage({
      gmail: {} as never,
      accessToken: "access-token",
      logger,
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "100",
        after: "2026-07-01T00:00:00.000Z",
      }),
      limit: 100,
    });

    expect(page.upsertedMessages.map((item) => item.id)).toEqual(["omitted"]);
    expect(page.deletedMessageIds).toEqual([]);
  });

  it("keeps recent messages including archived mail and removes ones outside the time window", async () => {
    const recentInternalDate = new Date("2026-07-02T00:00:00.000Z")
      .getTime()
      .toString();
    const oldInternalDate = new Date("2025-06-30T00:00:00.000Z")
      .getTime()
      .toString();

    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          messagesAdded: [
            { message: { id: "inbox-message" } },
            { message: { id: "unavailable-label-message" } },
            { message: { id: "archived-message", threadId: "changed-thread" } },
            { message: { id: "old-message" } },
            { message: { id: "missing-message" } },
          ],
          messagesDeleted: [{ message: { id: "deleted-message" } }],
        },
      ],
      historyId: "200",
    });
    vi.mocked(getMessagesBatch).mockResolvedValue([
      {
        ...getMockMessage({
          id: "inbox-message",
          labelIds: ["INBOX"],
        }),
        internalDate: recentInternalDate,
      },
      {
        ...getMockMessage({ id: "unavailable-label-message" }),
        internalDate: recentInternalDate,
        labelIds: undefined,
      },
      {
        ...getMockMessage({
          id: "archived-message",
          labelIds: [],
        }),
        internalDate: recentInternalDate,
      },
      {
        ...getMockMessage({
          id: "old-message",
          labelIds: ["INBOX"],
        }),
        internalDate: oldInternalDate,
      },
    ]);

    const page = await getGmailMailboxSyncPage({
      gmail: {} as never,
      accessToken: "access-token",
      logger,
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "100",
        after: "2026-07-01T00:00:00.000Z",
      }),
      limit: 100,
    });

    expect(getHistory).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        historyTypes: [
          "messageAdded",
          "messageDeleted",
          "labelAdded",
          "labelRemoved",
        ],
        startHistoryId: "100",
      }),
      logger,
    );
    expect(page.upsertedMessages.map((message) => message.id)).toEqual([
      "inbox-message",
      "unavailable-label-message",
      "archived-message",
    ]);
    expect(page.changedThreadIds).toEqual(["changed-thread"]);
    expect(page.deletedMessageIds).toEqual([
      "deleted-message",
      "old-message",
      "missing-message",
    ]);
  });

  it("rebuilds from snapshot when Gmail history returns 404", async () => {
    vi.mocked(getHistory).mockRejectedValue({ status: 404 });
    vi.mocked(getMessagesBatch).mockResolvedValue([
      {
        ...getMockMessage({
          id: "inbox-message",
          labelIds: ["INBOX"],
        }),
        internalDate: new Date("2026-07-02T00:00:00.000Z").getTime().toString(),
      },
    ]);
    const gmail = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: "300" } }),
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: [{ id: "inbox-message" }] },
          }),
        },
      },
    };

    const page = await getGmailMailboxSyncPage({
      gmail: gmail as never,
      accessToken: "access-token",
      logger,
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "1",
        after: "2026-07-01T00:00:00.000Z",
      }),
      limit: 100,
    });

    expect(page.reset).toBe(true);
    expect(page.upsertedMessages.map((message) => message.id)).toEqual([
      "inbox-message",
    ]);
    expect(gmail.users.getProfile).toHaveBeenCalled();
  });

  it("shows the newest mail of a large backlog first and still applies every change", async () => {
    // 300 records naming 5 messages each: 1500 changed messages.
    const gmail = fakeGmailHistory(300, 5);

    const pages = await readUntilCaughtUp(gmail.read, startCursor());

    expect(ids(pages[0])).toEqual(
      expect.arrayContaining(gmail.messagesOf(gmail.records.length - 1)),
    );
    expect(pages[0].hasMore).toBe(true);
    for (const page of pages) {
      expect(page.cursor.length).toBeLessThanOrEqual(16_384);
    }
    expect(new Set(pages.flatMap(ids))).toEqual(new Set(gmail.allMessages()));
    expect(pages.at(-1)?.hasMore).toBe(false);
  });

  it("previews the newest mail of a backlog too long to scan", async () => {
    const gmail = fakeGmailHistory(6000, 1);
    const listed = gmail.messagesOf(gmail.records.length - 1);
    const client = {
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: "9000" } }),
        messages: {
          list: vi.fn().mockResolvedValue({
            data: { messages: listed.map((id) => ({ id })) },
          }),
        },
      },
    };

    const first = await gmail.read(startCursor(), client);

    expect(ids(first)).toEqual(listed);
    expect(first.hasMore).toBe(true);
    expect(first.cursor.length).toBeLessThanOrEqual(16_384);
  });

  it("shows mail that arrives during a replay before the rest of the replay", async () => {
    const gmail = fakeGmailHistory(300, 5);
    const first = await gmail.read(startCursor());

    gmail.addRecord(["fresh"]);
    const second = await gmail.read(first.cursor);

    expect(ids(second)).toContain("fresh");
    expect(second.cursor.length).toBeLessThanOrEqual(16_384);
  });

  it("catches up a short backlog in one history read", async () => {
    const gmail = fakeGmailHistory(3, 2);

    const page = await gmail.read(startCursor());

    expect(new Set(ids(page))).toEqual(new Set(gmail.allMessages()));
    expect(page.hasMore).toBe(false);
    expect(getHistory).toHaveBeenCalledTimes(1);
  });

  it("writes current labels for an archived message instead of deleting it", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          labelsRemoved: [
            {
              labelIds: ["INBOX"],
              message: { id: "archived-message", threadId: "alert-thread" },
            },
          ],
        },
      ],
      historyId: "200",
    });
    vi.mocked(getMessagesBatch).mockResolvedValue([
      {
        ...getMockMessage({
          id: "archived-message",
          labelIds: ["UNREAD"],
        }),
        internalDate: new Date("2026-07-02T00:00:00.000Z").getTime().toString(),
      },
    ]);

    const page = await getGmailMailboxSyncPage({
      gmail: {} as never,
      accessToken: "access-token",
      logger,
      cursor: encodeMailboxSyncCursor({
        version: 1,
        provider: "google",
        phase: "delta",
        historyId: "100",
        after: "2026-07-01T00:00:00.000Z",
      }),
      limit: 100,
    });

    expect(page.upsertedMessages.map((message) => message.id)).toEqual([
      "archived-message",
    ]);
    expect(page.upsertedMessages[0]?.labelIds).toEqual(["UNREAD"]);
    expect(page.deletedMessageIds).toEqual([]);
    expect(page.changedThreadIds).toEqual(["alert-thread"]);
  });
});

describe("getGmailMailboxChangeIds", () => {
  it("deduplicates updates and lets deletion win within one page", () => {
    const result = getGmailMailboxChangeIds([
      {
        messagesAdded: [
          { message: { id: "added" } },
          { message: { id: "deleted" } },
        ],
        labelsAdded: [{ message: { id: "label-change" } }],
        labelsRemoved: [
          { message: { id: "label-change" } },
          { message: { id: "deleted" } },
        ],
        messagesDeleted: [{ message: { id: "deleted" } }],
      },
    ]);

    expect(result.upsertIds).toEqual(["added", "label-change"]);
    expect(result.deletedIds).toEqual(new Set(["deleted"]));
  });

  it("fetches summary messages when Gmail omits typed history arrays", () => {
    const result = getGmailMailboxChangeIds([
      {
        messages: [{ id: "archived", threadId: "alert-thread" }],
      },
    ]);

    expect(result.upsertIds).toEqual(["archived"]);
    expect(result.changedThreadIds).toEqual(new Set(["alert-thread"]));
  });
});

const RECENT = new Date("2026-07-02T00:00:00.000Z").getTime().toString();

// Gmail history whose records each name `perRecord` messages, paged by
// `maxResults` from `startHistoryId` like the real API.
function fakeGmailHistory(recordCount: number, perRecord: number) {
  const records: { id: number; messages: string[] }[] = [];
  let nextMessage = 0;
  const addRecord = (messages?: string[]) => {
    records.push({
      id: 101 + records.length,
      messages:
        messages ??
        Array.from({ length: perRecord }, () =>
          (nextMessage++).toString(16).padStart(16, "0"),
        ),
    });
  };
  for (let index = 0; index < recordCount; index++) addRecord();
  vi.mocked(getHistory).mockImplementation(async (_gmail, options) => {
    const eligible = records.filter(
      (record) => record.id > Number(options.startHistoryId),
    );
    const offset = Number(options.pageToken ?? 0);
    const slice = eligible.slice(offset, offset + (options.maxResults ?? 100));
    const end = offset + slice.length;
    return {
      history: slice.map((record) => ({
        id: String(record.id),
        messages: record.messages.map((id) => ({ id, threadId: `t-${id}` })),
      })),
      historyId: String(records.at(-1)?.id ?? 100),
      nextPageToken: end < eligible.length ? String(end) : undefined,
    };
  });
  vi.mocked(getMessagesBatch).mockImplementation(async ({ messageIds }) =>
    messageIds.map((id) => ({
      ...getMockMessage({ id, labelIds: ["INBOX"] }),
      internalDate: RECENT,
    })),
  );
  return {
    records,
    addRecord: (messages: string[]) => addRecord(messages),
    messagesOf: (index: number) => records[index]?.messages ?? [],
    allMessages: () => records.flatMap((record) => record.messages),
    read: (cursor: string, gmail: unknown = {}) =>
      getGmailMailboxSyncPage({
        gmail: gmail as never,
        accessToken: "access-token",
        logger,
        cursor,
        limit: 50,
      }),
  };
}

async function readUntilCaughtUp(
  read: (cursor: string) => ReturnType<typeof getGmailMailboxSyncPage>,
  cursor: string,
) {
  const pages = [await read(cursor)];
  while (pages.at(-1)?.hasMore && pages.length < 1000) {
    pages.push(await read(pages.at(-1)?.cursor ?? cursor));
  }
  return pages;
}

function startCursor() {
  return encodeMailboxSyncCursor({
    version: 1,
    provider: "google",
    phase: "delta",
    historyId: "100",
    after: "2026-07-01T00:00:00.000Z",
  });
}

function ids(page: { upsertedMessages: { id: string }[] }) {
  return page.upsertedMessages.map((message) => message.id);
}
