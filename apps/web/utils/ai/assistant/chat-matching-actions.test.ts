import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import type { EmailProvider } from "@/utils/email/types";
import {
  cancelMatchingQueryAction,
  confirmMatchingQueryAction,
  MATCHING_CONFIRM_EXPIRED,
  previewMatchingQueryAction,
} from "./chat-matching-actions";

const { mockStartMatchingBulkJob, store } = vi.hoisted(() => ({
  mockStartMatchingBulkJob: vi.fn(async () => "job-1"),
  store: new Map<string, string>(),
}));
const { mockGetOwnedEmailAccount } = vi.hoisted(() => ({
  mockGetOwnedEmailAccount: vi.fn(),
}));
vi.mock("@/utils/ai/assistant/chat-other-accounts", () => ({
  getOwnedEmailAccount: mockGetOwnedEmailAccount,
}));
vi.mock("@/utils/mail-bulk/start-matching-job", () => ({
  startMatchingBulkJob: mockStartMatchingBulkJob,
}));
// GETDEL reads and deletes in one step, as Redis does.
vi.mock("@/utils/redis", () => ({
  redis: {
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return "OK";
    }),
    pttl: vi.fn(async (key: string) => (store.has(key) ? 600_000 : -2)),
    getdel: vi.fn(async (key: string) => {
      const value = store.get(key) ?? null;
      store.delete(key);
      return value;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  },
}));

const ACCOUNT = "account-1";
const OTHER = "account-2";
const USER = "user-1";
const CHAT = "chat-1";
const CALL = "call-1";
const QUERY = "category:promotions after:2025/01/01 before:2026/01/01";
const logger = createTestLogger();

describe("previewMatchingQueryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it("counts only what archiving would change and starts nothing", async () => {
    const provider = listingProvider(30);

    const result = await preview({ emailProvider: provider });

    // Archiving lists only what is still in the inbox, as the job will.
    expect(provider.listMatchingMessages).toHaveBeenCalledWith({
      scope: { q: QUERY },
      only: { inInbox: true },
      pageToken: undefined,
    });
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "needs_confirmation",
      conversations: 15,
      messages: 30,
      confirmToken: expect.any(String),
    });
  });

  it("stores ids and a keyed hash for the token, never the search (R-1)", async () => {
    await preview({});

    const [stored] = [...store.values()];
    expect(stored).toBeDefined();
    expect(stored).not.toContain("promotions");
    expect(JSON.parse(stored ?? "")).toEqual({
      chatId: CHAT,
      toolCallId: CALL,
      action: "archive",
      conversations: 15,
      accounts: [
        {
          emailAccountId: ACCOUNT,
          queryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ],
    });
  });

  it("only counts, with no token to confirm, outside the web chat", async () => {
    const result = await preview({ confirmation: undefined });

    expect(result).toMatchObject({ status: "needs_confirmation" });
    expect(result).not.toHaveProperty("confirmToken");
    expect(store.size).toBe(0);
  });

  // Calling again, after a "yes", a "no", or an injected message, only
  // counts again: the model has no way to start the job.
  it("never starts a job however often it is called", async () => {
    const first = await preview({});
    const second = await preview({});

    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
    expect(first).toMatchObject({ status: "needs_confirmation" });
    expect(second).toMatchObject({ status: "needs_confirmation" });
  });

  it("says there is nothing to change rather than offering to confirm zero", async () => {
    const result = await preview({ emailProvider: listingProvider(0) });
    expect(result).toMatchObject({ status: "nothing_to_change" });
    expect(store.size).toBe(0);
  });

  it("reads an Outlook search as searchInbox does before listing it", async () => {
    const provider = listingProvider(4);
    await preview({
      emailProvider: provider,
      provider: "microsoft",
      query: "from:billing@vendor.example",
      bulkAction: "mark_read",
    });
    expect(provider.listMatchingMessages).toHaveBeenCalledWith({
      scope: { q: "from:billing@vendor.example" },
      only: { unread: true },
      pageToken: undefined,
    });
  });

  it("refuses an Outlook read state the job's view can't hold", async () => {
    const result = await preview({
      provider: "microsoft",
      query: "unread",
      bulkAction: "archive",
    });
    expect(result).toEqual({ error: expect.any(String) });
  });
});

describe("confirmMatchingQueryAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it("starts the select-all job for the previewed search in the chat's account", async () => {
    const token = await previewToken();

    const started = await confirm({ confirmToken: token });

    expect(mockStartMatchingBulkJob).toHaveBeenCalledWith({
      emailAccountId: ACCOUNT,
      scope: { q: QUERY },
      action: "archive",
      labelId: undefined,
      logger,
    });
    expect(started).toEqual({
      jobId: "job-1",
      action: "archive",
      messageCap: expect.any(Number),
      jobs: [
        {
          emailAccountId: ACCOUNT,
          jobId: "job-1",
          messageCap: expect.any(Number),
        },
      ],
    });
  });

  it("can't start a second job from a token already used", async () => {
    const token = await previewToken();
    await confirm({ confirmToken: token });

    await expect(confirm({ confirmToken: token })).rejects.toThrow(
      MATCHING_CONFIRM_EXPIRED,
    );
    expect(mockStartMatchingBulkJob).toHaveBeenCalledTimes(1);
  });

  it("starts one job when Confirm is pressed twice at once", async () => {
    const token = await previewToken();

    const results = await Promise.allSettled([
      confirm({ confirmToken: token }),
      confirm({ confirmToken: token }),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(mockStartMatchingBulkJob).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["another chat", { chatId: "chat-2" }],
    ["another tool call", { toolCallId: "call-2" }],
    ["a different search", { query: "category:social" }],
    ["another account", { emailAccountId: "account-2" }],
  ])("refuses a token presented for %s", async (_name, override) => {
    const token = await previewToken();

    await expect(confirm({ confirmToken: token, ...override })).rejects.toThrow(
      MATCHING_CONFIRM_EXPIRED,
    );
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
  });

  it("can't be confirmed once cancelled", async () => {
    const token = await previewToken();
    await cancel(token);

    await expect(confirm({ confirmToken: token })).rejects.toThrow(
      MATCHING_CONFIRM_EXPIRED,
    );
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
  });
});

describe("Confirm and Cancel racing for one token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  // Confirm in one tab, Cancel in another: the card must never say
  // cancelled while the job runs.
  it("lets Confirm win and refuses the Cancel that lost", async () => {
    const token = await previewToken();

    const [confirmed, cancelled] = await Promise.allSettled([
      confirm({ confirmToken: token }),
      cancel(token),
    ]);

    expect(confirmed.status).toBe("fulfilled");
    expect(cancelled).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({ message: MATCHING_CONFIRM_EXPIRED }),
    });
    expect(mockStartMatchingBulkJob).toHaveBeenCalledTimes(1);
  });

  it("lets Cancel win and starts nothing", async () => {
    const token = await previewToken();

    const [cancelled, confirmed] = await Promise.allSettled([
      cancel(token),
      confirm({ confirmToken: token }),
    ]);

    expect(cancelled.status).toBe("fulfilled");
    expect(confirmed.status).toBe("rejected");
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
  });

  it("only cancels a token for its own card", async () => {
    const token = await previewToken();

    await expect(
      cancelMatchingQueryAction({
        emailAccountId: ACCOUNT,
        chatId: "chat-2",
        toolCallId: CALL,
        confirmToken: token,
        logger,
      }),
    ).rejects.toThrow(MATCHING_CONFIRM_EXPIRED);
  });

  it("puts the token back when the job fails to start, so Confirm can be retried", async () => {
    const token = await previewToken();
    mockStartMatchingBulkJob.mockRejectedValueOnce(new Error("queue down"));

    await expect(confirm({ confirmToken: token })).rejects.toThrow(
      "queue down",
    );
    await expect(confirm({ confirmToken: token })).resolves.toMatchObject({
      jobId: "job-1",
    });
    expect(mockStartMatchingBulkJob).toHaveBeenCalledTimes(2);
  });
});

describe("a token issued before conversations was stored", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
  });

  it("still confirms", async () => {
    const token = await previewTokenWithoutConversations();

    await expect(confirm({ confirmToken: token })).resolves.toMatchObject({
      jobId: "job-1",
      action: "archive",
    });
  });

  it("still cancels", async () => {
    const token = await previewTokenWithoutConversations();

    await expect(cancel(token)).resolves.toBeUndefined();
    await expect(confirm({ confirmToken: token })).rejects.toThrow(
      MATCHING_CONFIRM_EXPIRED,
    );
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
  });
});

describe("a search-wide action across the user's accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    mockGetOwnedEmailAccount.mockResolvedValue({
      id: OTHER,
      email: "two@example.com",
      provider: "google",
    });
  });

  it("counts every account into one card, with each account's count", async () => {
    const result = await previewAcrossAccounts();

    expect(result).toMatchObject({
      status: "needs_confirmation",
      conversations: 15 + 4,
      messages: 30 + 8,
      accounts: [
        { account: "me@example.com", conversations: 15, messages: 30 },
        { account: "two@example.com", conversations: 4, messages: 8 },
      ],
      confirmToken: expect.any(String),
    });
  });

  it("stores each account's id and keyed hash, never the search (R-1)", async () => {
    await previewAcrossAccounts();

    const [stored] = [...store.values()];
    expect(stored).not.toContain("promotions");
    expect(JSON.parse(stored ?? "").accounts).toEqual([
      { emailAccountId: ACCOUNT, queryHash: expect.any(String) },
      { emailAccountId: OTHER, queryHash: expect.any(String) },
    ]);
  });

  it("starts one job in each account the card counted", async () => {
    const token = await tokenAcrossAccounts();
    mockStartMatchingBulkJob
      .mockResolvedValueOnce("job-1")
      .mockResolvedValueOnce("job-2");

    const started = await confirm({ confirmToken: token });

    expect(mockStartMatchingBulkJob).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: ACCOUNT }),
    );
    expect(mockStartMatchingBulkJob).toHaveBeenCalledWith(
      expect.objectContaining({ emailAccountId: OTHER, scope: { q: QUERY } }),
    );
    expect(started.jobs).toEqual([
      expect.objectContaining({ emailAccountId: ACCOUNT, jobId: "job-1" }),
      expect.objectContaining({ emailAccountId: OTHER, jobId: "job-2" }),
    ]);
  });

  it("starts nothing when an account is no longer the user's", async () => {
    const token = await tokenAcrossAccounts();
    mockGetOwnedEmailAccount.mockResolvedValue(null);

    await expect(confirm({ confirmToken: token })).rejects.toThrow(
      MATCHING_CONFIRM_EXPIRED,
    );
    expect(mockStartMatchingBulkJob).not.toHaveBeenCalled();
    expect(mockGetOwnedEmailAccount).toHaveBeenCalledWith({
      userId: USER,
      emailAccountId: OTHER,
    });
  });

  it("leaves out an account with nothing to change, and reports one that can't be counted", async () => {
    const result = await preview({
      otherAccounts: {
        chatEmail: "me@example.com",
        previews: [
          {
            account: { id: OTHER, email: "two@example.com" },
            search: { query: QUERY },
            count: { conversations: 0, total: 0, capped: false },
          },
          {
            account: { id: "account-3", email: "three@example.com" },
            error: "This account did not answer in time.",
          },
        ],
      },
    });

    expect(result).toMatchObject({
      conversations: 15,
      accounts: [
        { account: "me@example.com", conversations: 15 },
        { account: "two@example.com", conversations: 0 },
        { account: "three@example.com", error: expect.any(String) },
      ],
    });
    const [stored] = [...store.values()];
    expect(JSON.parse(stored ?? "").accounts).toHaveLength(1);
  });
});

function previewAcrossAccounts() {
  return preview({
    otherAccounts: {
      chatEmail: "me@example.com",
      previews: [
        {
          account: { id: OTHER, email: "two@example.com" },
          search: { query: QUERY },
          count: { conversations: 4, total: 8, capped: false },
        },
      ],
    },
  });
}

async function tokenAcrossAccounts() {
  const result = await previewAcrossAccounts();
  if (!("confirmToken" in result) || !result.confirmToken)
    throw new Error("no token");
  return result.confirmToken;
}

function cancel(confirmToken: string) {
  return cancelMatchingQueryAction({
    emailAccountId: ACCOUNT,
    chatId: CHAT,
    toolCallId: CALL,
    confirmToken,
    logger,
  });
}

function preview(
  overrides: Partial<Parameters<typeof previewMatchingQueryAction>[0]>,
) {
  return previewMatchingQueryAction({
    originalAction: "archive_threads",
    query: QUERY,
    bulkAction: "archive",
    emailProvider: listingProvider(30),
    emailAccountId: ACCOUNT,
    provider: "google",
    confirmation: { chatId: CHAT, toolCallId: CALL },
    ...overrides,
  });
}

async function previewToken() {
  const result = await preview({});
  if (!("confirmToken" in result) || !result.confirmToken)
    throw new Error("no token");
  return result.confirmToken;
}

async function previewTokenWithoutConversations() {
  const token = await previewToken();
  const [key, value] = [...store.entries()][0] ?? [];
  if (!key || !value) throw new Error("no stored token");
  const { conversations: _conversations, ...legacy } = JSON.parse(value);
  store.set(key, JSON.stringify(legacy));
  return token;
}

function confirm(
  overrides: Partial<Parameters<typeof confirmMatchingQueryAction>[0]> & {
    confirmToken: string;
  },
) {
  return confirmMatchingQueryAction({
    emailAccountId: ACCOUNT,
    provider: "google",
    userId: USER,
    chatId: CHAT,
    toolCallId: CALL,
    query: QUERY,
    logger,
    ...overrides,
  });
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
