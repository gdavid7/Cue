import { tool } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  runOnOtherAccounts,
  withChatAccountScope,
} from "./chat-other-accounts";
import { toOtherAccountEmailId } from "./other-account-email-id";

vi.mock("@/utils/prisma");

const USER_ID = "user-1";
const CHAT_ACCOUNT = "account-1";
const OTHER_ACCOUNT = "account-2";
const toolCallOptions = { toolCallId: "call-1", messages: [] } as never;
const logger = createTestLogger();

function connectedAccount(
  id: string,
  email: string,
  provider = "google",
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

function scopedTools() {
  const manageInbox = vi.fn(async (input: unknown) => ({ ok: true, input }));
  const readEmail = vi.fn(async (input: unknown) => ({ ok: true, input }));
  const tools = withChatAccountScope({
    userId: USER_ID,
    emailAccountId: CHAT_ACCOUNT,
    crossAccountTools: ["readEmail"],
    tools: {
      manageInbox: tool({
        inputSchema: z.object({
          action: z.string(),
          threadIds: z.array(z.string()),
        }),
        execute: manageInbox,
      }),
      replyEmail: tool({
        inputSchema: z.object({ messageId: z.string(), content: z.string() }),
        execute: async (input) => ({ ok: true, input }),
      }),
      readEmail: tool({
        inputSchema: z.object({ messageId: z.string() }),
        execute: readEmail,
      }),
    },
  });
  return { tools, manageInbox, readEmail };
}

describe("withChatAccountScope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findMany.mockResolvedValue([
      connectedAccount(OTHER_ACCOUNT, "other@example.com"),
    ] as never);
  });

  it("refuses a write on another account's email and names that account", async () => {
    const { tools, manageInbox } = scopedTools();

    const result = await tools.manageInbox.execute?.(
      {
        action: "archive_threads",
        threadIds: ["thread-1", toOtherAccountEmailId(OTHER_ACCOUNT, "t-9")],
      },
      toolCallOptions,
    );

    expect(manageInbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      error: expect.stringContaining("other@example.com"),
    });
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: OTHER_ACCOUNT, userId: USER_ID }),
      }),
    );
  });

  it("refuses a reply to another account's message", async () => {
    const { tools } = scopedTools();

    const result = await tools.replyEmail.execute?.(
      {
        messageId: toOtherAccountEmailId(OTHER_ACCOUNT, "m-9"),
        content: "Thanks!",
      },
      toolCallOptions,
    );

    expect(result).toMatchObject({ error: expect.any(String) });
    expect(result).not.toHaveProperty("ok");
  });

  it("does not reveal or act on an account the user does not own", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([]);
    const { tools, manageInbox } = scopedTools();

    const result = await tools.manageInbox.execute?.(
      {
        action: "archive_threads",
        threadIds: [toOtherAccountEmailId("someone-elses", "t-1")],
      },
      toolCallOptions,
    );

    expect(manageInbox).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("someone-elses");
  });

  it("passes the chat account's own ids through untouched", async () => {
    const { tools, manageInbox } = scopedTools();

    await tools.manageInbox.execute?.(
      { action: "archive_threads", threadIds: ["thread-1", "thread-2"] },
      toolCallOptions,
    );

    expect(manageInbox).toHaveBeenCalledWith(
      { action: "archive_threads", threadIds: ["thread-1", "thread-2"] },
      toolCallOptions,
    );
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it("unwraps an id that names the chat's own account", async () => {
    const { tools, manageInbox } = scopedTools();

    await tools.manageInbox.execute?.(
      {
        action: "archive_threads",
        threadIds: [toOtherAccountEmailId(CHAT_ACCOUNT, "thread-1")],
      },
      toolCallOptions,
    );

    expect(manageInbox).toHaveBeenCalledWith(
      { action: "archive_threads", threadIds: ["thread-1"] },
      toolCallOptions,
    );
  });

  it("lets a cross-account read tool resolve another account's id itself", async () => {
    const { tools, readEmail } = scopedTools();
    const messageId = toOtherAccountEmailId(OTHER_ACCOUNT, "m-9");

    await tools.readEmail.execute?.({ messageId }, toolCallOptions);

    expect(readEmail).toHaveBeenCalledWith({ messageId }, toolCallOptions);
  });
});

describe("runOnOtherAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches only the signed-in user's other connected accounts", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      connectedAccount(CHAT_ACCOUNT, "me@example.com"),
      connectedAccount(OTHER_ACCOUNT, "other@example.com", "microsoft"),
    ] as never);
    const run = vi.fn(async (account: { id: string }) => account.id);

    const { results } = await runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      run,
    });

    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: USER_ID }),
      }),
    );
    expect(run).toHaveBeenCalledTimes(1);
    expect(results).toEqual([
      {
        account: expect.objectContaining({
          id: OTHER_ACCOUNT,
          email: "other@example.com",
          provider: "microsoft",
        }),
        result: OTHER_ACCOUNT,
      },
    ]);
  });

  it("reports one account's failure without losing the others", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      connectedAccount("account-2", "two@example.com"),
      connectedAccount("account-3", "three@example.com"),
    ] as never);

    const { results } = await runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      run: async (account) => {
        if (account.id === "account-2") throw new Error("token revoked");
        return "ok";
      },
    });

    expect(results).toEqual([
      {
        account: expect.objectContaining({ id: "account-2" }),
        error: expect.any(String),
      },
      { account: expect.objectContaining({ id: "account-3" }), result: "ok" },
    ]);
  });

  it("runs a bounded number of accounts at once", async () => {
    prisma.emailAccount.findMany.mockResolvedValue(
      Array.from({ length: 8 }, (_, index) =>
        connectedAccount(`account-${index + 2}`, `a${index}@example.com`),
      ) as never,
    );
    let running = 0;
    let maxRunning = 0;

    await runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      run: async () => {
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
      },
    });

    expect(maxRunning).toBeGreaterThan(1);
    expect(maxRunning).toBeLessThanOrEqual(3);
  });

  it("gives up on an account that does not answer in time", async () => {
    vi.useFakeTimers();
    try {
      prisma.emailAccount.findMany.mockResolvedValue([
        connectedAccount(OTHER_ACCOUNT, "other@example.com"),
      ] as never);

      const pending = runOnOtherAccounts({
        userId: USER_ID,
        emailAccountId: CHAT_ACCOUNT,
        logger,
        run: () => new Promise(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(20_000);

      expect((await pending).results).toEqual([
        {
          account: expect.objectContaining({ id: OTHER_ACCOUNT }),
          error: expect.stringMatching(/time/i),
        },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers within one deadline for all accounts, however many there are", async () => {
    vi.useFakeTimers();
    try {
      prisma.emailAccount.findMany.mockResolvedValue(
        Array.from({ length: 10 }, (_, index) =>
          connectedAccount(`account-${index + 2}`, `a${index}@example.com`),
        ) as never,
      );
      const signals: AbortSignal[] = [];
      let settled = false;

      const pending = runOnOtherAccounts({
        userId: USER_ID,
        emailAccountId: CHAT_ACCOUNT,
        logger,
        run: (_account, signal) => {
          signals.push(signal);
          return new Promise(() => undefined);
        },
      }).then(({ results }) => {
        settled = true;
        return results;
      });

      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1500);
      expect(settled).toBe(true);

      const results = await pending;
      expect(results).toHaveLength(10);
      for (const result of results) {
        expect(result).toEqual({
          account: expect.any(Object),
          error: "This account did not answer in time.",
        });
      }
      // Accounts still queued at the deadline are never started.
      expect(signals).toHaveLength(3);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves out accounts the user keeps out of All inboxes, and counts them", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      connectedAccount("account-2", "two@example.com"),
      connectedAccount("account-3", "three@example.com", "google", false),
    ] as never);
    const run = vi.fn(async () => "ok");

    const { results, notSearchedCount } = await runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      run,
    });

    expect(run).toHaveBeenCalledTimes(1);
    expect(results.map((entry) => entry.account.id)).toEqual(["account-2"]);
    expect(notSearchedCount).toBe(1);
  });

  it("counts the accounts past the cap as not searched", async () => {
    prisma.emailAccount.findMany.mockResolvedValue(
      Array.from({ length: 12 }, (_, index) =>
        connectedAccount(`account-${index + 2}`, `a${index}@example.com`),
      ) as never,
    );

    const { results, notSearchedCount } = await runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      run: async () => "ok",
    });

    expect(results).toHaveLength(10);
    expect(notSearchedCount).toBe(2);
  });

  it("stops the accounts' searches when the chat turn is stopped", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      connectedAccount(OTHER_ACCOUNT, "other@example.com"),
    ] as never);
    const turn = new AbortController();
    let accountSignal: AbortSignal | undefined;

    const pending = runOnOtherAccounts({
      userId: USER_ID,
      emailAccountId: CHAT_ACCOUNT,
      logger,
      abortSignal: turn.signal,
      run: (_account, signal) => {
        accountSignal = signal;
        return new Promise(() => undefined);
      },
    });
    await vi.waitFor(() => expect(accountSignal).toBeDefined());
    turn.abort();

    expect((await pending).results).toHaveLength(1);
    expect(accountSignal?.aborted).toBe(true);
  });
});
