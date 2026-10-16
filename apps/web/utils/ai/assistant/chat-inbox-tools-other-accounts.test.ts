import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import {
  readAttachmentTool,
  readEmailTool,
  searchInboxTool,
} from "./chat-inbox-tools";
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

  it("searches only the chat's account unless asked for all accounts", async () => {
    const result = await search("google", { query: "contract renewal" });

    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
    expect(createEmailProvider).toHaveBeenCalledTimes(1);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).not.toHaveProperty("account");
    expect(result).not.toHaveProperty("accounts");
  });

  it("labels every message with the account it is in", async () => {
    const result = await search("google", {
      query: "contract renewal",
      allAccounts: true,
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
      allAccounts: true,
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
    await search("google", { query: "contract renewal", allAccounts: true });

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
    }).execute?.({ query: "contract renewal", limit: 20, allAccounts: true }, {
      toolCallId: "call-1",
      messages: [],
      abortSignal: turn.signal,
    } as never);

    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
  });

  it("caps each other account's results below a full page", async () => {
    await search("google", {
      query: "contract renewal",
      limit: 20,
      allAccounts: true,
    });

    expect(providers["account-1"].searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ maxResults: 20 }),
    );
    for (const id of ["account-2", "account-3"]) {
      const [{ maxResults }] = providers[id].searchMessages.mock.calls[0];
      expect(maxResults).toBeLessThanOrEqual(10);
    }
  });

  it("walks later pages in the chat's account only", async () => {
    await search("google", {
      query: "contract renewal",
      pageToken: "PAGE_2",
      allAccounts: true,
    });

    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
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
        allAccounts: true,
      },
      toolCallOptions,
    );

    const [{ query }] = providers["account-2"].searchMessages.mock.calls[0];
    expect(query).toContain("from:legal@acme.example");
    expect(query).toContain("is:unread");
    expect(query).toContain("renewal");
  });

  it("keeps an Outlook folder search in the chat's account", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.outlook,
      accounts.gmail,
    ] as never);
    providers["account-3"].getFolders = vi
      .fn()
      .mockResolvedValue([
        { id: "folder-legal", displayName: "Legal", childFolders: [] },
      ]);

    await searchInboxTool({
      email: "three@example.com",
      emailAccountId: "account-3",
      userId: USER_ID,
      provider: "microsoft",
      logger,
    }).execute?.(
      { query: "", folderName: "Legal", limit: 20, allAccounts: true },
      toolCallOptions,
    );

    expect(providers["account-2"].searchMessages).not.toHaveBeenCalled();
  });

  it("says how many of the user's accounts it did not search", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      accounts.chat,
      accounts.gmail,
      connectedAccount("account-3", "three@example.com", "microsoft", false),
    ] as never);

    const result = await search("google", {
      query: "contract renewal",
      allAccounts: true,
    });

    expect(providers["account-3"].searchMessages).not.toHaveBeenCalled();
    expect(result.accountsNotSearched).toBe(1);
  });

  it("rewrites a Gmail chat's search for an Outlook account", async () => {
    const result = await search("google", {
      query: "from:legal@acme.example is:unread label:work renewal",
      allAccounts: true,
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

  it("does not search an account the search has nothing for", async () => {
    const result = await search("google", {
      query: "in:inbox label:work",
      allAccounts: true,
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
      allAccounts: true,
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

function fakeProvider(messageId: string, threadId: string) {
  const message = getMockMessage({
    id: messageId,
    threadId,
    from: "legal@acme.example",
    subject: "Contract renewal",
  });
  return {
    searchMessages: vi.fn().mockResolvedValue({ messages: [message] }),
    getLabels: vi.fn().mockResolvedValue([]),
    getMessage: vi.fn().mockResolvedValue(message),
    getAttachment: vi.fn().mockResolvedValue({
      data: Buffer.from("hello").toString("base64"),
      size: 5,
    }),
    getFolders: vi.fn().mockResolvedValue([]),
  };
}
