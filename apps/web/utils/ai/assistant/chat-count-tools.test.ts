import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getMockMessage } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import type { EmailProvider } from "@/utils/email/types";
import type {
  LocalMailCountAnswer,
  LocalMailSearch,
} from "@/utils/ai/assistant/local-mail-search";
import {
  countEmails,
  countWithProvider,
  toMatchingScope,
} from "./chat-count-tools";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider");

const ACCOUNT = "account-1";
const OTHER = "account-2";
const logger = createTestLogger();

describe("toMatchingScope", () => {
  it("covers the whole mailbox for a search and all mail for an empty one", () => {
    expect(toMatchingScope({ query: "from:news@shop.example" })).toEqual({
      scope: { q: "from:news@shop.example" },
      only: {},
    });
    expect(toMatchingScope({ query: "  " })).toEqual({
      scope: { type: "all" },
      only: {},
    });
  });

  it("turns Outlook's sender and read state into a search term and a read filter", () => {
    expect(
      toMatchingScope({
        query: "invoice",
        fromEmail: "billing@vendor.example",
        readState: "unread",
      }),
    ).toEqual({
      scope: { q: "invoice from:billing@vendor.example" },
      only: { unread: true },
    });
  });
});

describe("countWithProvider", () => {
  it("counts every listed page up to the cap and keeps the first ids as the newest", async () => {
    const provider = listingProvider(1200, 500);

    expect(
      await countWithProvider({
        emailProvider: provider,
        scope: { q: "x" },
        only: {},
      }),
    ).toMatchObject({
      total: 1200,
      conversations: 600,
      capped: false,
      newestIds: [
        { id: "m-0", threadId: "t-0" },
        { id: "m-1", threadId: "t-0" },
        { id: "m-2", threadId: "t-1" },
        { id: "m-3", threadId: "t-1" },
        { id: "m-4", threadId: "t-2" },
      ],
    });

    const capped = await countWithProvider({
      emailProvider: listingProvider(1200, 500),
      scope: { q: "x" },
      only: {},
      maxMessages: 1000,
    });
    expect(capped).toMatchObject({ total: 1000, capped: true });
  });
});

describe("countEmails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers from the browser's exact count and resolves sender groups from the provider", async () => {
    const provider = headersProvider();
    vi.mocked(createEmailProvider).mockResolvedValue(provider);
    const local = localCount({
      status: "counted",
      accounts: [{ accountId: ACCOUNT, total: 4812 }],
      groups: [
        { count: 3120, messageId: "g1", accountId: ACCOUNT },
        { count: 1692, messageId: "g2", accountId: ACCOUNT },
      ],
      groupCount: 2,
      newest: [{ id: "n1", threadId: "tn1", accountId: ACCOUNT }],
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "newer_than:1y", groupBy: "sender" },
    });

    expect(local.count).toHaveBeenCalledWith({
      searches: [
        { accountId: ACCOUNT, query: "newer_than:1y", syntax: "gmail" },
      ],
      groupBy: "sender",
    });
    // Nothing is listed from the provider when the browser counted it all.
    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
    expect(result).toEqual({
      queryUsed: "newer_than:1y",
      total: 4812,
      exact: true,
      groupBy: "sender",
      groups: [
        { sender: "Sender g1 <g1@example.com>", count: 3120 },
        { sender: "Sender g2 <g2@example.com>", count: 1692 },
      ],
      newest: [
        {
          messageId: "n1",
          threadId: "t-n1",
          subject: "Subject n1",
          from: "Sender n1 <n1@example.com>",
          date: expect.any(String),
        },
      ],
    });
  });

  // The model sees totals, a dozen groups and five headers at most, never
  // the matches themselves.
  it("gives the model aggregates only, however much mail matched", async () => {
    vi.mocked(createEmailProvider).mockResolvedValue(headersProvider());
    const local = localCount({
      status: "counted",
      accounts: [{ accountId: ACCOUNT, total: 250_000 }],
      groups: Array.from({ length: 12 }, (_, index) => ({
        key: `2026-${String(12 - index).padStart(2, "0")}`,
        count: 1000 + index,
        messageId: `g${index}`,
        accountId: ACCOUNT,
      })),
      groupCount: 40,
      newest: Array.from({ length: 5 }, (_, index) => ({
        id: `n${index}`,
        threadId: `t${index}`,
        accountId: ACCOUNT,
      })),
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "", groupBy: "month" },
    });

    expect(Object.keys(result).sort()).toEqual(
      [
        "exact",
        "groupBy",
        "groups",
        "moreGroups",
        "newest",
        "queryUsed",
        "total",
      ].sort(),
    );
    if (!("groups" in result) || !result.groups) throw new Error("no groups");
    expect(result.groups).toHaveLength(12);
    expect(result.moreGroups).toBe(28);
    expect(result.newest).toHaveLength(5);
    for (const example of result.newest) {
      expect(Object.keys(example).sort()).toEqual(
        ["date", "from", "messageId", "subject", "threadId"].sort(),
      );
    }
    expect(JSON.stringify(result)).not.toContain("snippet");
    expect(JSON.stringify(result).length).toBeLessThan(2500);
  });

  it("counts with the provider, bounded, when the browser can't, and says the groups are incomplete", async () => {
    const provider = listingProvider(700, 500);
    vi.mocked(createEmailProvider).mockResolvedValue(provider);
    const local = localCount({
      status: "counted",
      accounts: [{ accountId: ACCOUNT, unavailable: "not_synced" }],
      groups: [],
      groupCount: 0,
      newest: [],
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "from:ada@example.com", groupBy: "month" },
    });

    expect(provider.listMatchingMessages).toHaveBeenCalledWith({
      scope: { q: "from:ada@example.com" },
      only: {},
      pageToken: undefined,
    });
    expect(result).toMatchObject({
      total: 700,
      exact: true,
      groups: [],
      groupsIncomplete: expect.any(String),
    });
    if (!("newest" in result)) throw new Error("no examples");
    expect(result.newest.map((item) => item.messageId)).toEqual([
      "m-0",
      "m-1",
      "m-2",
      "m-3",
      "m-4",
    ]);
  });

  it("counts the user's other included accounts too and lists each account's total", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      account(ACCOUNT, "me@example.com", "google"),
      account(OTHER, "me@work.example", "microsoft"),
    ] as never);
    vi.mocked(createEmailProvider).mockResolvedValue(headersProvider());
    const local = localCount({
      status: "counted",
      accounts: [
        { accountId: ACCOUNT, total: 10 },
        { accountId: OTHER, total: 5 },
      ],
      groups: [],
      groupCount: 0,
      newest: [{ id: "n1", threadId: "t1", accountId: OTHER }],
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "from:ada@example.com", allAccounts: true },
    });

    expect(local.count).toHaveBeenCalledWith({
      searches: [
        { accountId: ACCOUNT, query: "from:ada@example.com", syntax: "gmail" },
        {
          accountId: OTHER,
          query: "",
          syntax: "outlook",
          fromEmail: "ada@example.com",
        },
      ],
      groupBy: undefined,
    });
    expect(result).toMatchObject({
      total: 15,
      exact: true,
      accounts: [
        { account: "me@example.com", total: 10, exact: true },
        { account: "me@work.example", total: 5, exact: true },
      ],
      newest: [{ account: "me@work.example" }],
    });
    if (!("newest" in result)) throw new Error("no examples");
    // Another account's ids name their account, so readEmail can follow them.
    expect(result.newest[0]?.messageId).not.toBe("n1");
  });
});

describe("countEmails across accounts and groups", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads an Outlook search as searchInbox does when the provider counts it", async () => {
    const provider = listingProvider(3, 500);
    vi.mocked(createEmailProvider).mockResolvedValue(provider);

    await countEmails({
      options: { ...options(), provider: "microsoft" },
      input: { query: "unread from:ada@example.com" },
    });

    expect(provider.listMatchingMessages).toHaveBeenCalledWith({
      scope: { q: "from:ada@example.com" },
      only: { unread: true },
      pageToken: undefined,
    });
  });

  it("isn't exact when some of the user's accounts were left out", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      account(ACCOUNT, "me@example.com", "google"),
      account(OTHER, "me@work.example", "google"),
      {
        ...account("account-3", "old@example.com", "google"),
        includeInAllAccounts: false,
      },
    ] as never);
    vi.mocked(createEmailProvider).mockResolvedValue(headersProvider());
    const local = localCount({
      status: "counted",
      accounts: [
        { accountId: ACCOUNT, total: 2 },
        { accountId: OTHER, total: 1 },
      ],
      groups: [],
      groupCount: 0,
      newest: [],
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "", allAccounts: true },
    });

    expect(result).toMatchObject({
      total: 3,
      exact: false,
      accountsNotSearched: 1,
    });
  });

  it("lists only groups it could name and says when the largest could not be", async () => {
    const provider = headersProvider();
    provider.getLabels = vi.fn(async () => [
      { id: "Label_1", name: "Receipts" },
    ]) as never;
    vi.mocked(createEmailProvider).mockResolvedValue(provider);
    const local = localCount({
      status: "counted",
      accounts: [{ accountId: ACCOUNT, total: 30 }],
      groups: [
        { key: "Label_gone", count: 20, messageId: "g1", accountId: ACCOUNT },
        { key: "Label_1", count: 10, messageId: "g2", accountId: ACCOUNT },
      ],
      groupCount: 2,
      newest: [],
    });

    const result = await countEmails({
      options: options(local),
      input: { query: "", groupBy: "label" },
    });

    expect(result).toMatchObject({
      groups: [{ label: "Receipts", count: 10 }],
      moreGroups: 1,
      groupsIncomplete: expect.any(String),
    });
  });
});

function options(localMailSearch?: LocalMailSearch) {
  return {
    email: "me@example.com",
    emailAccountId: ACCOUNT,
    provider: "google",
    userId: "user-1",
    logger,
    localMailSearch,
  };
}

function localCount(answer: LocalMailCountAnswer) {
  return {
    search: vi.fn(async () => null),
    count: vi.fn(async () => answer),
  };
}

function account(id: string, email: string, provider: string) {
  return {
    id,
    email,
    name: null,
    image: null,
    includeInAllAccounts: true,
    account: { provider },
  };
}

function headersProvider() {
  return {
    name: "google",
    listMatchingMessages: vi.fn(async () => ({ messages: [] })),
    getLabels: vi.fn(async () => []),
    getMessagesBatch: vi.fn(async (ids: string[]) =>
      ids.map((id) =>
        getMockMessage({
          id,
          threadId: `t-${id}`,
          from: `Sender ${id} <${id}@example.com>`,
          subject: `Subject ${id}`,
        }),
      ),
    ),
  } as unknown as EmailProvider & {
    listMatchingMessages: ReturnType<typeof vi.fn>;
  };
}

/** A provider listing `total` messages, two per thread, newest first. */
function listingProvider(total: number, pageSize: number) {
  const provider = headersProvider();
  provider.listMatchingMessages = vi.fn(
    async ({ pageToken }: { pageToken?: string }) => {
      const start = pageToken ? Number(pageToken) : 0;
      const end = Math.min(total, start + pageSize);
      return {
        messages: Array.from({ length: end - start }, (_, offset) => {
          const index = start + offset;
          return { id: `m-${index}`, threadId: `t-${Math.floor(index / 2)}` };
        }),
        nextPageToken: end < total ? String(end) : undefined,
      };
    },
  );
  provider.getMessagesBatch = vi.fn(async (ids: string[]) =>
    ids.map((id, index) => ({
      ...getMockMessage({
        id,
        threadId: `t-${id}`,
        from: "ada@example.com",
        subject: `Subject ${id}`,
      }),
      date: new Date(Date.UTC(2026, 9, 10) - index * 60_000).toISOString(),
    })),
  );
  return provider;
}
