import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import {
  decodeMailboxSyncCursor,
  encodeMailboxSyncCursor,
} from "@/utils/email/mailbox-sync";
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

  it("spreads a backlog of more than 1000 deletions over pages a sync page can hold", async () => {
    // Emptying Trash while Cue is closed: one deletion per record.
    const deleted = Array.from({ length: 1500 }, (_, index) => `d${index}`);
    vi.mocked(getHistory).mockImplementation(async (_gmail, options) => {
      const eligible = deleted
        .map((id, index) => ({ id, historyId: 101 + index }))
        .filter((record) => record.historyId > Number(options.startHistoryId));
      const offset = Number(options.pageToken ?? 0);
      const slice = eligible.slice(
        offset,
        offset + (options.maxResults ?? 100),
      );
      const end = offset + slice.length;
      return {
        history: slice.map((record) => ({
          id: String(record.historyId),
          messagesDeleted: [{ message: { id: record.id, threadId: "t" } }],
        })),
        historyId: String(100 + deleted.length),
        nextPageToken: end < eligible.length ? String(end) : undefined,
      };
    });
    vi.mocked(getMessagesBatch).mockResolvedValue([]);
    const read = (cursor: string) =>
      getGmailMailboxSyncPage({
        gmail: {} as never,
        accessToken: "access-token",
        logger,
        cursor,
        limit: 50,
      });

    const pages = await readUntilCaughtUp(read, startCursor());

    for (const page of pages) {
      expect(page.deletedMessageIds.length).toBeLessThanOrEqual(1000);
    }
    expect(new Set(pages.flatMap((page) => page.deletedMessageIds))).toEqual(
      new Set(deleted),
    );
  });

  it("keeps every replay page small when history records name many messages", async () => {
    // Thread-wide changes: 50 messages a record, and one record naming 1500.
    const gmail = fakeGmailHistory(200, 50);
    const huge = Array.from({ length: 1500 }, (_, index) => `huge-${index}`);
    gmail.addRecord(huge);

    const pages = await readUntilCaughtUp(gmail.read, startCursor());

    for (const page of pages) {
      // Every message a page fetched in full can keep its body.
      expect(page.upsertedMessages.length).toBeLessThanOrEqual(50);
      expect(
        page.upsertedMessages.length + page.deletedMessageIds.length,
      ).toBeLessThanOrEqual(1000);
      expect(page.cursor.length).toBeLessThanOrEqual(16_384);
    }
    expect(new Set(pages.flatMap(ids))).toEqual(new Set(gmail.allMessages()));
    expect(pages.at(-1)?.hasMore).toBe(false);
  });

  it("recovers from a page token Gmail no longer accepts", async () => {
    const gmail = fakeGmailHistory(120, 1);
    // A cursor written by an earlier version, mid-replay, holding a token
    // minted for another page size.
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: "100",
      after: "2026-07-01T00:00:00.000Z",
      pageToken: "40:7:100",
    });

    const pages = await readUntilCaughtUp(gmail.read, cursor);

    expect(new Set(pages.flatMap(ids))).toEqual(new Set(gmail.allMessages()));
    expect(pages.at(-1)?.hasMore).toBe(false);
  });

  it("starts a short catch-up's next read clean of a split record's progress", async () => {
    const gmail = fakeGmailHistory(3, 1);
    const cursor = encodeMailboxSyncCursor({
      version: 1,
      provider: "google",
      phase: "delta",
      historyId: "100",
      after: "2026-07-01T00:00:00.000Z",
      replayedChanges: 5,
    });

    const page = await gmail.read(cursor);

    expect(decodeMailboxSyncCursor(page.cursor, "google")).not.toHaveProperty(
      "replayedChanges",
    );
  });

  it("previews new mail ahead of later label changes on older mail", async () => {
    const relabeled = Array.from({ length: 300 }, (_, index) => `old-${index}`);
    const history = [
      { messagesAdded: [{ message: { id: "new-mail", threadId: "t-new" } }] },
      ...relabeled.map((id) => ({
        labelsAdded: [{ labelIds: ["Label_1"], message: { id, threadId: id } }],
      })),
    ];
    vi.mocked(getHistory).mockResolvedValue({ history, historyId: "500" });
    vi.mocked(getMessagesBatch).mockImplementation(async ({ messageIds }) =>
      messageIds.map((id) => ({
        ...getMockMessage({ id, labelIds: ["INBOX"] }),
        internalDate: RECENT,
      })),
    );

    const first = await getGmailMailboxSyncPage({
      gmail: {} as never,
      accessToken: "access-token",
      logger,
      cursor: startCursor(),
      limit: 50,
    });

    expect(ids(first)).toContain("new-mail");
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

  // A first sync's backfill lists the inbox first; mail moved into the inbox
  // after that phase passed its date is the primary stream's to bring, since
  // its cursor covers all time.
  it("brings an old message moved into the inbox from an all-time cursor", async () => {
    vi.mocked(getHistory).mockResolvedValue({
      history: [
        {
          labelsAdded: [
            {
              labelIds: ["INBOX"],
              message: { id: "moved-to-inbox", threadId: "old-thread" },
            },
          ],
        },
      ],
      historyId: "200",
    });
    vi.mocked(getMessagesBatch).mockResolvedValue([
      {
        ...getMockMessage({ id: "moved-to-inbox", labelIds: ["INBOX"] }),
        internalDate: String(Date.now() - 400 * 24 * 60 * 60 * 1000),
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
        after: new Date(0).toISOString(),
      }),
      limit: 100,
    });

    expect(page.upsertedMessages.map((message) => message.id)).toEqual([
      "moved-to-inbox",
    ]);
    expect(page.upsertedMessages[0]?.labelIds).toEqual(["INBOX"]);
    expect(page.deletedMessageIds).toEqual([]);
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
  // Gmail does not promise that a page token works with another page size or
  // start, so this fake refuses one used with anything but what minted it.
  vi.mocked(getHistory).mockImplementation(async (_gmail, options) => {
    const maxResults = options.maxResults ?? 100;
    let offset = 0;
    if (options.pageToken) {
      const [tokenOffset, tokenSize, tokenStart] = options.pageToken.split(":");
      if (
        Number(tokenSize) !== maxResults ||
        tokenStart !== options.startHistoryId
      ) {
        throw Object.assign(new Error("Invalid pageToken"), { status: 400 });
      }
      offset = Number(tokenOffset);
    }
    const eligible = records.filter(
      (record) => record.id > Number(options.startHistoryId),
    );
    const slice = eligible.slice(offset, offset + maxResults);
    const end = offset + slice.length;
    return {
      history: slice.map((record) => ({
        id: String(record.id),
        messages: record.messages.map((id) => ({ id, threadId: `t-${id}` })),
      })),
      historyId: String(records.at(-1)?.id ?? 100),
      nextPageToken:
        end < eligible.length
          ? `${end}:${maxResults}:${options.startHistoryId}`
          : undefined,
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
