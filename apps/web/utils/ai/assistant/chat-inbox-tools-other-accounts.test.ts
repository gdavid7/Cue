import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import {
  manageInboxTool,
  readAttachmentTool,
  readEmailTool,
  replyEmailTool,
  searchInboxTool,
} from "./chat-inbox-tools";
import { toAllAccountsPageToken } from "./all-accounts-page-token";
import { toOtherAccountEmailId } from "./other-account-email-id";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/posthog", () => ({
  posthogCaptureEvent: vi.fn().mockResolvedValue(undefined),
}));

const USER_ID = "user-1";
const CHAT_EMAIL = "me@example.com";
const logger = createTestLogger();

const accounts = {
  chat: connectedAccount("account-1", CHAT_EMAIL, "google"),
  gmail: connectedAccount("account-2", "two@example.com", "google"),
  outlook: connectedAccount("account-3", "three@example.com", "microsoft"),
};

let providers: Record<string, ReturnType<typeof fakeProvider>>;

describe("searchInbox across the user's accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = {
      "account-1": fakeProvider("chat-msg", "chat-thread"),
      "account-2": fakeProvider("gmail-msg", "gmail-thread"),
      "account-3": fakeProvider("outlook-msg", "outlook-thread"),
    };
    vi.mocked(createEmailProvider).mockImplementation(
      async ({ emailAccountId }) => providers[emailAccountId] as never,
    );
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.chat,
      accounts.gmail,
      accounts.outlook,
    ] as never);
  });

  it("gives a user with one covered account that account's result as it is", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([accounts.chat] as never);

    const result = await search("google", { query: "contract renewal" });

    expect(createEmailProvider).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).not.toHaveProperty("account");
    expect(result).not.toHaveProperty("accounts");
  });

  it("labels every message with the account it is in", async () => {
    const result = await search("google", {
      query: "contract renewal",
    });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      }),
    );
    expect(result.messages.map((m: { account: string }) => m.account)).toEqual([
      CHAT_EMAIL,
      "two@example.com",
      "three@example.com",
    ]);
    expect(result.accounts).toEqual([
      expect.objectContaining({ account: CHAT_EMAIL, returned: 1 }),
      expect.objectContaining({ account: "two@example.com", returned: 1 }),
      expect.objectContaining({ account: "three@example.com", returned: 1 }),
    ]);
    expect(result.totalReturned).toBe(3);
  });

  it("gives another account's emails ids that carry their account", async () => {
    const result = await search("google", {
      query: "contract renewal",
    });

    expect(result.messages[0]).toMatchObject({
      messageId: "chat-msg",
      threadId: "chat-thread",
    });
    expect(result.messages[1]).toMatchObject({
      messageId: toOtherAccountEmailId("account-2", "gmail-msg"),
      threadId: toOtherAccountEmailId("account-2", "gmail-thread"),
      externalUrl: expect.stringContaining(
        encodeURIComponent("two@example.com"),
      ),
    });
    expect(result.messages[2]).toMatchObject({
      messageId: toOtherAccountEmailId("account-3", "outlook-msg"),
    });
  });

  it("gives other accounts' searches a signal that can stop them", async () => {
    await search("google", { query: "contract renewal" });

    const [{ signal }] = providers["account-2"].searchMessages.mock.calls[0];
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("does not search other accounts once the chat turn is stopped", async () => {
    const turn = new AbortController();
    turn.abort();

    await searchInboxTool({
      email: CHAT_EMAIL,
      emailAccountId: "account-1",
      userId: USER_ID,
      provider: "google",
      logger,
    }).execute?.({ query: "contract renewal", limit: 20 }, {
      toolCallId: "call-1",
      messages: [],
      abortSignal: turn.signal,
    } as never);

    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
  });

  it("gives each account a share of the page, so the page stays one page long", async () => {
    await search("google", {
      query: "contract renewal",
      limit: 20,
    });

    const shares = ["account-1", "account-2", "account-3"].map(
      (id) => providers[id].searchMessages.mock.calls[0][0].maxResults,
    );
    expect(shares).toEqual([7, 7, 6]);
  });

  it("keeps a short page to its limit, and continues the accounts left out from their first page", async () => {
    for (const id of ["account-1", "account-2", "account-3"]) {
      providers[id].searchMessages.mockImplementation(
        async ({ maxResults }: { maxResults: number }) => ({
          messages: Array.from({ length: maxResults }, (_, index) =>
            messageOn(`${id}-msg-${index}`, "2026-01-01T10:00:00Z"),
          ),
          nextPageToken: `${id}-PAGE_2`,
        }),
      );
    }

    const first = await search("google", {
      query: "contract renewal",
      limit: 2,
    });

    expect(first.messages).toHaveLength(2);
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
    expect(first.hasMore).toBe(true);
    vi.clearAllMocks();

    await search("google", {
      query: "contract renewal",
      limit: 20,
      pageToken: first.nextPageToken,
    });

    expect(providers["account-1"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "account-1-PAGE_2" }),
    );
    expect(providers["account-2"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "account-2-PAGE_2" }),
    );
    const [{ pageToken: thirdPageToken }] =
      providers["account-3"].searchMessages.mock.calls[0];
    expect(thirdPageToken).toBeUndefined();
  });

  it("gives the accounts a short page left out the next pages first, so each gets its turn", async () => {
    for (const id of ["account-1", "account-2", "account-3"]) {
      providers[id].searchMessages.mockImplementation(async () => ({
        messages: [messageOn(`${id}-msg`, "2026-01-01T10:00:00Z")],
        nextPageToken: `${id}-NEXT`,
      }));
    }

    const searchedOnEachPage: string[][] = [];
    const chatAccountOnEachPage: unknown[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 3; page++) {
      vi.clearAllMocks();
      const result = await search("google", {
        query: "contract renewal",
        limit: 1,
        pageToken,
      });
      pageToken = result.nextPageToken;
      chatAccountOnEachPage.push(result.accounts[0]);
      searchedOnEachPage.push(
        ["account-1", "account-2", "account-3"].filter(
          (id) => providers[id].searchMessages.mock.calls.length > 0,
        ),
      );
    }

    expect(searchedOnEachPage).toEqual([
      ["account-1"],
      ["account-2"],
      ["account-3"],
    ]);
    // Left out of a page, the chat's account still has more to find.
    expect(chatAccountOnEachPage[1]).toEqual({
      account: CHAT_EMAIL,
      returned: 0,
      hasMore: true,
    });
  });

  it("ignores an account in a page token that is not one of the user's", async () => {
    const result = await search("google", {
      query: "contract renewal",
      pageToken: toAllAccountsPageToken({
        "account-2": "GMAIL_PAGE_2",
        "account-9": "FOREIGN_PAGE_2",
      }),
    });

    expect(createEmailProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "account-9" }),
    );
    expect(providers["account-2"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "GMAIL_PAGE_2" }),
    );
    expect(providers["account-1"].searchMessages).not.toHaveBeenCalled();
    expect(result.messages).toHaveLength(1);
    expect(result.nextPageToken).toBeUndefined();
  });

  it("lists every account's messages newest first", async () => {
    providers["account-1"].searchMessages.mockResolvedValue({
      messages: [messageOn("chat-old", "2026-01-01T10:00:00Z")],
    });
    providers["account-3"].searchMessages.mockResolvedValue({
      messages: [messageOn("outlook-new", "2026-03-01T10:00:00Z")],
    });
    providers["account-2"].searchMessages.mockResolvedValue({
      messages: [messageOn("gmail-mid", "2026-02-01T10:00:00Z")],
    });

    const result = await search("google", { query: "contract renewal" });

    expect(result.messages.map((m: { account: string }) => m.account)).toEqual([
      "three@example.com",
      "two@example.com",
      CHAT_EMAIL,
    ]);
  });

  it("continues each account that has more from its own page, in one page token", async () => {
    providers["account-1"].searchMessages.mockResolvedValue({
      messages: [messageOn("chat-msg", "2026-01-01T10:00:00Z")],
      nextPageToken: "CHAT_PAGE_2",
    });
    providers["account-2"].searchMessages.mockResolvedValue({
      messages: [messageOn("gmail-msg", "2026-01-02T10:00:00Z")],
      nextPageToken: "GMAIL_PAGE_2",
    });

    const first = await search("google", { query: "contract renewal" });

    expect(first.hasMore).toBe(true);
    expect(first.nextPageToken).toEqual(expect.any(String));
    vi.clearAllMocks();

    await search("google", {
      query: "contract renewal",
      pageToken: first.nextPageToken,
    });

    expect(providers["account-1"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "CHAT_PAGE_2" }),
    );
    expect(providers["account-2"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "GMAIL_PAGE_2" }),
    );
    // Every match in the Outlook account was on the first page.
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
  });

  it("continues only the chat's account from a single provider's page token", async () => {
    await search("google", {
      query: "contract renewal",
      pageToken: "PAGE_2",
    });

    expect(providers["account-1"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ pageToken: "PAGE_2" }),
    );
    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
  });

  it("reports the chat account's failed search only for that account when others found mail", async () => {
    providers["account-1"].searchMessages.mockRejectedValue(
      new Error("Gmail unavailable"),
    );

    const result = await search("google", {
      query: "contract renewal",
    });

    expect(result).not.toHaveProperty("error");
    expect(result.accounts[0]).toEqual({
      account: CHAT_EMAIL,
      error: expect.any(String),
    });
    expect(result.messages).toHaveLength(2);
  });

  it("keeps the chat account's failure as the result's error when nothing else was found", async () => {
    providers["account-1"].searchMessages.mockRejectedValue(
      new Error("Gmail unavailable"),
    );
    providers["account-2"].searchMessages.mockResolvedValue({ messages: [] });
    providers["account-3"].searchMessages.mockResolvedValue({ messages: [] });

    const result = await search("google", {
      query: "contract renewal",
    });

    expect(result.error).toEqual(expect.any(String));
  });

  it("carries an Outlook chat's sender and read state to a Gmail account", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.outlook,
      accounts.gmail,
    ] as never);

    await searchInboxTool({
      email: "three@example.com",
      emailAccountId: "account-3",
      userId: USER_ID,
      provider: "microsoft",
      logger,
    }).execute?.(
      {
        query: "renewal",
        fromEmail: "legal@acme.example",
        readState: "unread",
        limit: 20,
      },
      toolCallOptions,
    );

    const [{ query }] = providers["account-2"].searchMessages.mock.calls[0];
    expect(query).toContain("from:legal@acme.example");
    expect(query).toContain("is:unread");
    expect(query).toContain("renewal");
  });

  it.each([
    { query: "folder:Legal" },
    { query: 'category:"Legal"' },
    { query: "", folderName: "Legal" },
  ])("searches another account's own label of an Outlook search's folder or category name (%o)", async (input) => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.outlook,
      accounts.gmail,
    ] as never);
    providers["account-3"].getFolders = vi
      .fn()
      .mockResolvedValue([
        { id: "folder-legal", displayName: "Legal", childFolders: [] },
      ]);
    providers["account-3"].getLabels.mockResolvedValue([
      { id: "cat-legal", name: "Legal" },
    ]);
    providers["account-2"].getLabels.mockResolvedValue([
      { id: "Label_7", name: "Legal" },
    ]);

    const result: any = await searchInboxTool({
      email: "three@example.com",
      emailAccountId: "account-3",
      userId: USER_ID,
      provider: "microsoft",
      logger,
    }).execute?.({ limit: 20, ...input } as never, toolCallOptions);

    expect(providers["account-2"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'label:"Legal"' }),
    );
    expect(result.accounts).toContainEqual(
      expect.objectContaining({ account: "two@example.com", returned: 1 }),
    );
  });

  it("reports an account without the folder, and creates nothing there", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.outlook,
      accounts.gmail,
    ] as never);
    providers["account-3"].getFolders = vi
      .fn()
      .mockResolvedValue([
        { id: "folder-legal", displayName: "Legal", childFolders: [] },
      ]);

    const result: any = await searchInboxTool({
      email: "three@example.com",
      emailAccountId: "account-3",
      userId: USER_ID,
      provider: "microsoft",
      logger,
    }).execute?.(
      { query: "", folderName: "Legal", limit: 20 },
      toolCallOptions,
    );

    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
    expect(result.accounts).toContainEqual({
      account: "two@example.com",
      error: "No folder or category with this name in this account.",
    });
    expect(result.messages).toHaveLength(1);
  });

  it("says how many of the user's accounts it did not search", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.chat,
      accounts.gmail,
      connectedAccount("account-3", "three@example.com", "microsoft", false),
    ] as never);

    const result = await search("google", {
      query: "contract renewal",
    });

    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
    expect(result.accountsNotSearched).toBe(1);
  });

  it("rewrites a Gmail chat's search for an Outlook account", async () => {
    const result = await search("google", {
      query: "from:legal@acme.example is:unread label:work renewal",
    });

    expect(providers["account-2"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "from:legal@acme.example is:unread label:work renewal",
      }),
    );
    const [outlookSearch] = providers["account-3"].searchMessages.mock.calls[0];
    expect(outlookSearch).toMatchObject({
      fromEmail: "legal@acme.example",
      readState: "unread",
    });
    expect(outlookSearch.query).not.toMatch(/label:|is:|from:/);
    expect(outlookSearch.query).toContain("renewal");
    expect(result.accounts).toContainEqual(
      expect.objectContaining({
        account: "three@example.com",
        keywordsOnly: true,
      }),
    );
    expect(
      result.accounts.find(
        (entry: { account: string }) => entry.account === "two@example.com",
      ),
    ).not.toHaveProperty("keywordsOnly");
  });

  it("searches an Outlook account for a link from a Gmail chat", async () => {
    const result = await search("google", {
      query: "https://acme.example/invoice",
    });

    const [outlookSearch] = providers["account-3"].searchMessages.mock.calls[0];
    expect(outlookSearch.query).toBe("https://acme.example/invoice");
    expect(result.accounts).toContainEqual(
      expect.objectContaining({ account: "three@example.com", returned: 1 }),
    );
  });

  it("does not search an account the search has nothing for", async () => {
    const result = await search("google", {
      query: "in:inbox label:work",
    });

    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
    expect(result.accounts).toContainEqual({
      account: "three@example.com",
      error: expect.any(String),
    });
  });

  it("reports an account that could not be searched as unsearched, not empty", async () => {
    providers["account-2"].searchMessages.mockRejectedValue(
      new Error("invalid_grant"),
    );

    const result = await search("google", {
      query: "contract renewal",
    });

    expect(result.accounts).toContainEqual(
      expect.objectContaining({
        account: "two@example.com",
        error: expect.any(String),
      }),
    );
    expect(result.messages).toHaveLength(2);
  });
});

describe("reading another account's email", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = {
      "account-1": fakeProvider("chat-msg", "chat-thread"),
      "account-2": fakeProvider("gmail-msg", "gmail-thread"),
    };
    vi.mocked(createEmailProvider).mockImplementation(
      async ({ emailAccountId }) => providers[emailAccountId] as never,
    );
  });

  it("reads it from its own account after checking the user owns it", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([accounts.gmail] as never);

    const result: any = await readEmailTool(chatToolOptions()).execute?.(
      { messageId: toOtherAccountEmailId("account-2", "gmail-msg") },
      toolCallOptions,
    );

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "account-2", userId: USER_ID }),
      }),
    );
    expect(providers["account-2"].getMessage).toHaveBeenCalledWith("gmail-msg");
    expect(providers["account-1"].getMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      messageId: toOtherAccountEmailId("account-2", "gmail-msg"),
      threadId: toOtherAccountEmailId("account-2", "gmail-thread"),
      account: "two@example.com",
      provider: "google",
    });
  });

  it("refuses an account the user does not own without touching any mailbox", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([]);

    const result: any = await readEmailTool(chatToolOptions()).execute?.(
      { messageId: toOtherAccountEmailId("account-9", "msg") },
      toolCallOptions,
    );

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(createEmailProvider).not.toHaveBeenCalled();
  });

  it("reads the chat account's own email as before", async () => {
    const result: any = await readEmailTool(chatToolOptions()).execute?.(
      { messageId: "chat-msg" },
      toolCallOptions,
    );

    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(providers["account-1"].getMessage).toHaveBeenCalledWith("chat-msg");
    expect(result).not.toHaveProperty("account");
  });

  it("reads an attachment from the account the email is in", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([accounts.gmail] as never);

    await readAttachmentTool(chatToolOptions()).execute?.(
      {
        messageId: toOtherAccountEmailId("account-2", "gmail-msg"),
        attachmentId: "att-1",
        mimeType: "text/plain",
        filename: "notes.txt",
      },
      toolCallOptions,
    );

    expect(providers["account-2"].getAttachment).toHaveBeenCalledWith(
      "gmail-msg",
      "att-1",
    );
    expect(providers["account-1"].getAttachment).not.toHaveBeenCalled();
  });
});

describe("changing email across the user's accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    providers = {
      "account-1": fakeProvider("chat-msg", "chat-thread"),
      "account-2": fakeProvider("gmail-msg", "gmail-thread"),
      "account-3": fakeProvider("outlook-msg", "outlook-thread"),
    };
    vi.mocked(createEmailProvider).mockImplementation(
      async ({ emailAccountId }) => providers[emailAccountId] as never,
    );
    prisma.emailAccount.findMany.mockImplementation((async (args: {
      where: { id?: string };
    }) =>
      [accounts.chat, accounts.gmail, accounts.outlook].filter(
        (account) => !args.where.id || account.id === args.where.id,
      )) as never);
  });

  it("archives each email in the account it is in, in one call", async () => {
    const result = await manage("google", {
      action: "archive_threads",
      threadIds: [
        "chat-thread",
        toOtherAccountEmailId("account-2", "gmail-thread"),
        toOtherAccountEmailId("account-3", "outlook-thread"),
      ],
    });

    expect(providers["account-1"].archiveThreadWithLabel).toHaveBeenCalledWith(
      "chat-thread",
      CHAT_EMAIL,
      undefined,
    );
    expect(providers["account-2"].archiveThreadWithLabel).toHaveBeenCalledWith(
      "gmail-thread",
      "two@example.com",
      undefined,
    );
    expect(providers["account-3"].archiveThreadWithLabel).toHaveBeenCalledWith(
      "outlook-thread",
      "three@example.com",
      undefined,
    );
    expect(result).toMatchObject({
      success: true,
      requestedCount: 3,
      successCount: 3,
      failedCount: 0,
    });
    expect(result.accounts).toEqual([
      expect.objectContaining({ account: CHAT_EMAIL, successCount: 1 }),
      expect.objectContaining({ account: "two@example.com", successCount: 1 }),
      expect.objectContaining({
        account: "three@example.com",
        successCount: 1,
      }),
    ]);
  });

  it("looks up the user's accounts once for a call, however many emails it names", async () => {
    await manage("google", {
      action: "archive_threads",
      threadIds: [
        toOtherAccountEmailId("account-2", "gmail-thread"),
        toOtherAccountEmailId("account-2", "gmail-thread-2"),
        toOtherAccountEmailId("account-3", "outlook-thread"),
        toOtherAccountEmailId("account-9", "thread-x"),
      ],
    });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      }),
    );
    expect(providers["account-2"].archiveThreadWithLabel).toHaveBeenCalledTimes(
      2,
    );
  });

  it("changes nothing for an email in no account of the user's, and only that email fails", async () => {
    const foreign = toOtherAccountEmailId("account-9", "thread-x");

    const result = await manage("google", {
      action: "archive_threads",
      threadIds: ["chat-thread", foreign],
    });

    expect(providers["account-1"].archiveThreadWithLabel).toHaveBeenCalledTimes(
      1,
    );
    expect(createEmailProvider).not.toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: "account-9" }),
    );
    expect(result).toMatchObject({
      success: false,
      successCount: 1,
      failedCount: 1,
      failedThreadIds: [foreign],
    });
  });

  it("applies an Outlook chat's category as an existing Gmail label, and fails only where it does not exist", async () => {
    prisma.emailAccount.findMany.mockImplementation((async (args: {
      where: { id?: string };
    }) =>
      [accounts.outlook, accounts.gmail].filter(
        (account) => !args.where.id || account.id === args.where.id,
      )) as never);
    providers["account-2"].getLabelByName.mockResolvedValue(null);
    providers["account-3"].getLabelByName.mockResolvedValue({
      id: "cat-1",
      name: "Clients",
    });

    const result: any = await manageInboxTool({
      email: "three@example.com",
      emailAccountId: "account-3",
      userId: USER_ID,
      provider: "microsoft",
      logger,
    }).execute?.(
      {
        action: "categorize_threads",
        categoryName: "Clients",
        threadIds: [
          "outlook-thread",
          toOtherAccountEmailId("account-2", "gmail-thread"),
        ],
      },
      toolCallOptions,
    );

    expect(providers["account-3"].labelMessage).toHaveBeenCalled();
    expect(providers["account-2"].labelMessage).not.toHaveBeenCalled();
    expect(providers["account-2"].createLabel).not.toHaveBeenCalled();
    expect(result).toMatchObject({ successCount: 1, failedCount: 1 });
    expect(result.accounts).toContainEqual(
      expect.objectContaining({
        account: "two@example.com",
        failedCount: 1,
        error: expect.stringContaining("Clients"),
      }),
    );
  });

  it("archives a sender's mail in every covered account that has mail from them", async () => {
    providers["account-3"].getMessagesFromSender.mockResolvedValue({
      messages: [],
    });

    const result = await manage("google", {
      action: "bulk_archive_senders",
      fromEmails: ["news@acme.example"],
    });

    for (const id of ["account-1", "account-2"]) {
      expect(providers[id].bulkArchiveFromSenders).toHaveBeenCalledWith(
        ["news@acme.example"],
        expect.any(String),
        id,
      );
    }
    expect(
      providers["account-3"].bulkArchiveFromSenders,
    ).not.toHaveBeenCalled();
    expect(result.accounts).toEqual([
      expect.objectContaining({ account: CHAT_EMAIL, sendersCount: 1 }),
      expect.objectContaining({ account: "two@example.com", sendersCount: 1 }),
      expect.objectContaining({
        account: "three@example.com",
        sendersCount: 0,
      }),
    ]);
  });

  it("finishes a slow sender-wide archive in every account, past the read deadline", async () => {
    vi.useFakeTimers();
    try {
      const more = [
        connectedAccount("account-4", "four@example.com", "google"),
        connectedAccount("account-5", "five@example.com", "google"),
      ];
      providers["account-4"] = fakeProvider("four-msg", "four-thread");
      providers["account-5"] = fakeProvider("five-msg", "five-thread");
      prisma.emailAccount.findMany.mockResolvedValue([
        accounts.chat,
        accounts.gmail,
        accounts.outlook,
        ...more,
      ] as never);
      let running = 0;
      let mostAtOnce = 0;
      for (const provider of Object.values(providers)) {
        provider.bulkArchiveFromSenders.mockImplementation(async () => {
          running += 1;
          mostAtOnce = Math.max(mostAtOnce, running);
          await new Promise((resolve) => setTimeout(resolve, 20_000));
          running -= 1;
        });
      }

      const pending = manage("google", {
        action: "bulk_archive_senders",
        fromEmails: ["news@acme.example"],
      });
      await vi.advanceTimersByTimeAsync(60_000);
      const result = await pending;

      for (const id of Object.keys(providers)) {
        expect(providers[id].bulkArchiveFromSenders).toHaveBeenCalledTimes(1);
      }
      expect(mostAtOnce).toBe(3);
      expect(result.success).toBe(true);
      expect(
        result.accounts.filter((entry: object) => "error" in entry),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a search-wide action in each account, and never acts on a search that only carries over as keywords", async () => {
    const result = await manage("google", {
      action: "archive_threads",
      query: "label:work older_than:1y",
    });

    expect(providers["account-1"].listMatchingMessages).toHaveBeenCalled();
    expect(providers["account-2"].listMatchingMessages).toHaveBeenCalled();
    expect(providers["account-3"].listMatchingMessages).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "needs_confirmation",
      conversations: 2,
      accounts: [
        { account: CHAT_EMAIL, conversations: 1 },
        { account: "two@example.com", conversations: 1 },
        { account: "three@example.com", error: expect.any(String) },
      ],
    });
  });

  it("counts a search-wide action in the other accounts when the chat's own account can't be reached", async () => {
    vi.mocked(createEmailProvider).mockImplementation(
      async ({ emailAccountId }) => {
        if (emailAccountId === "account-1") throw new Error("Disconnected");
        return providers[emailAccountId] as never;
      },
    );

    const result = await manage("google", {
      action: "archive_threads",
      query: "label:work older_than:1y",
    });

    expect(providers["account-2"].listMatchingMessages).toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "needs_confirmation",
      conversations: 1,
      accounts: [
        { account: CHAT_EMAIL, error: "Could not search this account." },
        { account: "two@example.com", conversations: 1 },
        { account: "three@example.com", error: expect.any(String) },
      ],
    });
  });

  it("prepares a reply that sends from the account the email is in", async () => {
    const result: any = await replyEmailTool(chatToolOptions()).execute?.(
      {
        messageId: toOtherAccountEmailId("account-2", "gmail-msg"),
        content: "Thanks!",
      },
      toolCallOptions,
    );

    expect(providers["account-2"].getMessage).toHaveBeenCalledWith("gmail-msg");
    expect(providers["account-1"].getMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      emailAccountId: "account-2",
      pendingAction: { messageId: "gmail-msg" },
    });
  });
});

const toolCallOptions = { toolCallId: "call-1", messages: [] } as never;

function chatToolOptions() {
  return {
    email: CHAT_EMAIL,
    emailAccountId: "account-1",
    userId: USER_ID,
    provider: "google",
    logger,
  };
}

async function manage(provider: string, input: Record<string, unknown>) {
  const result = await manageInboxTool({
    email: CHAT_EMAIL,
    emailAccountId: "account-1",
    userId: USER_ID,
    provider,
    logger,
  }).execute?.(input as never, toolCallOptions);
  return result as any;
}

async function search(provider: string, input: Record<string, unknown>) {
  const result = await searchInboxTool({
    email: CHAT_EMAIL,
    emailAccountId: "account-1",
    userId: USER_ID,
    provider,
    logger,
  }).execute?.({ limit: 20, ...input } as never, toolCallOptions);
  return result as any;
}

function connectedAccount(
  id: string,
  email: string,
  provider: string,
  includeInAllAccounts = true,
) {
  return {
    id,
    email,
    name: null,
    image: null,
    includeInAllAccounts,
    account: { provider },
  };
}

function messageOn(id: string, date: string) {
  return { ...getMockMessage({ id, threadId: `${id}-thread` }), date };
}

function fakeProvider(messageId: string, threadId: string) {
  // One date for every account's message, so they list in account order.
  const message = {
    ...getMockMessage({
      id: messageId,
      threadId,
      from: "legal@acme.example",
      subject: "Contract renewal",
    }),
    date: "2026-01-01T10:00:00Z",
  };
  return {
    searchMessages: vi.fn().mockResolvedValue({ messages: [message] }),
    getLabels: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue(message),
    getAttachment: vi.fn().mockResolvedValue({
      data: Buffer.from("hello").toString("base64"),
      size: 5,
    }),
    getFolders: vi.fn().mockResolvedValue([]),
    archiveThreadWithLabel: vi.fn().mockResolvedValue(undefined),
    getLabelByName: vi.fn().mockResolvedValue(null),
    createLabel: vi.fn(),
    getThreadMessages: vi.fn().mockResolvedValue([message]),
    labelMessage: vi.fn().mockResolvedValue(undefined),
    getMessagesFromSender: vi.fn().mockResolvedValue({ messages: [message] }),
    bulkArchiveFromSenders: vi.fn().mockResolvedValue(undefined),
    listMatchingMessages: vi
      .fn()
      .mockResolvedValue({ messages: [{ id: messageId, threadId }] }),
  };
}
