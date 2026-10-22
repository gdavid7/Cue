import { describe, expect, it, vi } from "vitest";
import type { gmail_v1 } from "@googleapis/gmail";
import {
  countGmailMatchingConversations,
  gmailMatchingListQuery,
  listGmailMatchingMessages,
} from "@/utils/gmail/matching";

describe("gmailMatchingListQuery", () => {
  it("reads the inbox when the scope names no view", () => {
    expect(gmailMatchingListQuery({}, {})).toEqual({
      labelIds: ["INBOX"],
      q: undefined,
      includeSpamTrash: false,
    });
  });

  it("searches the whole mailbox for a search scope", () => {
    expect(gmailMatchingListQuery({ q: "from:alerts" }, {})).toEqual({
      labelIds: [],
      q: "from:alerts",
      includeSpamTrash: false,
    });
  });

  it("narrows an archive to messages still in the inbox", () => {
    expect(
      gmailMatchingListQuery({ q: "older_than:1y" }, { inInbox: true }),
    ).toMatchObject({ labelIds: ["INBOX"], q: "older_than:1y" });
    expect(
      gmailMatchingListQuery({ labelId: "Label_1" }, { inInbox: true }),
    ).toMatchObject({ labelIds: ["Label_1", "INBOX"] });
  });

  it("narrows read changes to the messages they would change", () => {
    expect(gmailMatchingListQuery({}, { unread: true }).q).toBe("is:unread");
    expect(gmailMatchingListQuery({}, { unread: false }).q).toBe("-is:unread");
  });

  it("keeps the view's own filters", () => {
    expect(
      gmailMatchingListQuery({ type: "archive", isUnread: true }, {}),
    ).toEqual({
      labelIds: [],
      q: "-in:INBOX is:unread",
      includeSpamTrash: false,
    });
  });

  it("includes spam and trash when the view is one of them", () => {
    expect(gmailMatchingListQuery({ type: "trash" }, {})).toMatchObject({
      labelIds: ["TRASH"],
      includeSpamTrash: true,
    });
    expect(gmailMatchingListQuery({ q: "in:spam" }, {})).toMatchObject({
      includeSpamTrash: true,
    });
  });
});

describe("listGmailMatchingMessages", () => {
  it("lists message and thread ids a page at a time", async () => {
    const list = vi.fn().mockResolvedValue({
      data: {
        messages: [
          { id: "m1", threadId: "t1" },
          { id: "m2", threadId: "t1" },
          { id: null, threadId: "t2" },
        ],
        nextPageToken: "next",
      },
    });
    const gmail = {
      users: { messages: { list } },
    } as unknown as gmail_v1.Gmail;

    const result = await listGmailMatchingMessages({
      gmail,
      scope: { type: "inbox" },
      only: { unread: true },
      pageToken: "p1",
    });

    expect(result).toEqual({
      messages: [
        { id: "m1", threadId: "t1" },
        { id: "m2", threadId: "t1" },
      ],
      nextPageToken: "next",
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        labelIds: ["INBOX"],
        q: "is:unread",
        pageToken: "p1",
        maxResults: 500,
      }),
    );
  });
});

describe("listGmailMatchingMessages over a label's view", () => {
  // A digest conversation: only its first message carries the label.
  const thread = {
    messages: [
      { id: "m1", threadId: "t1", labelIds: ["INBOX", "UNREAD", "Label_42"] },
      { id: "m2", threadId: "t1", labelIds: ["INBOX", "UNREAD"] },
      { id: "m3", threadId: "t1", labelIds: [] },
    ],
  };
  const gmailFor = () => {
    const list = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "m1", threadId: "t1" }] },
    });
    const get = vi.fn().mockResolvedValue({ data: thread });
    const gmail = {
      users: { messages: { list }, threads: { get } },
    } as unknown as gmail_v1.Gmail;
    return { gmail, get };
  };

  it("archives the whole conversation, not just its labelled messages", async () => {
    const { gmail, get } = gmailFor();
    const result = await listGmailMatchingMessages({
      gmail,
      scope: { labelIds: ["INBOX", "Label_42"] },
      only: { inInbox: true },
    });
    expect(result.messages).toEqual([
      { id: "m1", threadId: "t1" },
      { id: "m2", threadId: "t1" },
    ]);
    expect(get).toHaveBeenCalledWith(
      expect.objectContaining({ id: "t1", format: "minimal" }),
    );
  });

  it("marks the whole conversation read", async () => {
    const { gmail } = gmailFor();
    const result = await listGmailMatchingMessages({
      gmail,
      scope: { labelIds: ["INBOX", "Label_42"] },
      only: { unread: true },
    });
    expect(result.messages.map((message) => message.id)).toEqual(["m1", "m2"]);
  });

  it("leaves a system view's listing per message", async () => {
    const { gmail, get } = gmailFor();
    await listGmailMatchingMessages({
      gmail,
      scope: { type: "inbox" },
      only: { inInbox: true },
    });
    expect(get).not.toHaveBeenCalled();
  });
});

describe("countGmailMatchingConversations", () => {
  it("reads a single-label view's conversation count from the label", async () => {
    const get = vi
      .fn()
      .mockResolvedValue({ data: { threadsTotal: 1234, threadsUnread: 56 } });
    const gmail = { users: { labels: { get } } } as unknown as gmail_v1.Gmail;

    await expect(
      countGmailMatchingConversations({ gmail, scope: { type: "inbox" } }),
    ).resolves.toBe(1234);
    await expect(
      countGmailMatchingConversations({
        gmail,
        scope: { labelId: "Label_1", isUnread: true },
      }),
    ).resolves.toBe(56);
    expect(get).toHaveBeenCalledWith({ userId: "me", id: "Label_1" });
  });

  it("has no exact count for a search", async () => {
    const gmail = {
      users: { labels: { get: vi.fn() } },
    } as unknown as gmail_v1.Gmail;

    await expect(
      countGmailMatchingConversations({ gmail, scope: { q: "invoice" } }),
    ).resolves.toBeNull();
    expect(gmail.users.labels.get).not.toHaveBeenCalled();
  });
});
