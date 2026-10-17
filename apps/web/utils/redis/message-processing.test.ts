import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import {
  countMessageProcessingFailure,
  deferMessageProcessing,
  acquireMessageProcessing,
  markMessageProcessed,
  acquireOutboundMessageLock,
  clearOutboundMessageLock,
  markMessageAsProcessing,
  markOutboundMessageProcessed,
} from "@/utils/redis/message-processing";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(() => "lock-uuid"),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    eval: vi.fn(),
    del: vi.fn(),
    multi: vi.fn(),
  },
}));

describe("countMessageProcessingFailure", () => {
  it("counts a failure and keeps when the message first failed, expiring both together", async () => {
    const commands: string[] = [];
    const transaction: Record<string, unknown> = {};
    for (const command of ["hincrby", "hsetnx", "expire", "hget"]) {
      transaction[command] = vi.fn((...args: unknown[]) => {
        commands.push(`${command} ${args.join(" ")}`);
        return transaction;
      });
    }
    transaction.exec = vi.fn().mockResolvedValue([2, 0, 1, 1_700_000_000_000]);
    vi.mocked(redis.multi).mockReturnValue(transaction as any);

    const result = await countMessageProcessingFailure({
      userEmail: "user@example.com",
      messageId: "message-1",
    });

    expect(result).toEqual({ failures: 2, firstFailedAt: 1_700_000_000_000 });
    expect(commands).toContainEqual(
      `expire processing-message-failures:user@example.com:message-1 ${8 * 24 * 60 * 60}`,
    );
  });
});

describe("message retries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const key = { userEmail: "user@example.com", messageId: "message-1" };

  async function deferAndReadBack(retryAt: number) {
    await deferMessageProcessing({ ...key, retryAt });
    const [processingKey, value, options] = vi.mocked(redis.set).mock
      .calls[0] as [string, string, object];
    vi.mocked(redis.get).mockResolvedValue(value);
    return { processingKey, options };
  }

  it("keeps a failed message from being claimed until its retry is due", async () => {
    const retryAt = Date.now() + 5 * 60_000;
    const { processingKey, options } = await deferAndReadBack(retryAt);
    vi.mocked(redis.set).mockResolvedValue(null);

    expect(processingKey).toBe("processing-message:user@example.com:message-1");
    expect(options).toEqual(expect.objectContaining({ nx: true }));
    expect(await acquireMessageProcessing(key)).toEqual({
      status: "retry-pending",
      retryAt,
    });
  });

  it("claims a message whose retry is due within moments, for a run arriving a little early", async () => {
    await deferAndReadBack(Date.now() + 2000);
    vi.mocked(redis.set)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("OK");

    expect(await acquireMessageProcessing(key)).toEqual({
      status: "acquired",
      lockToken: "lock-uuid",
    });
    expect(redis.del).toHaveBeenCalledWith(
      "processing-message:user@example.com:message-1",
    );
  });
});

describe("message-processing redis locks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acquires the short-lived webhook processing lock", async () => {
    vi.mocked(redis.set).mockResolvedValue("OK");

    const acquired = await markMessageAsProcessing({
      userEmail: "user@example.com",
      messageId: "message-1",
    });

    expect(acquired).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      "processing-message:user@example.com:message-1",
      "true",
      { ex: 300, nx: true },
    );
  });

  it("acquires an outbound message lock and returns its token", async () => {
    vi.mocked(redis.set).mockResolvedValue("OK");

    const lockToken = await acquireOutboundMessageLock({
      emailAccountId: "account-1",
      messageId: "message-1",
    });

    expect(lockToken).toBe("lock-uuid");
    expect(redis.set).toHaveBeenCalledWith(
      "reply-tracker:outbound-message:account-1:message-1",
      "lock-uuid",
      { ex: 1800, nx: true },
    );
  });

  it("marks an outbound message as processed only when the lock is owned", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    const marked = await markOutboundMessageProcessed({
      emailAccountId: "account-1",
      messageId: "message-1",
      lockToken: "lock-token-1",
    });

    expect(marked).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET"'),
      ["reply-tracker:outbound-message:account-1:message-1"],
      ["lock-token-1", "processed", "2592000"],
    );
  });

  it.each([
    [null, "processed", { status: "processed" }],
    [null, "true", { status: "held" }],
    ["OK", null, { status: "acquired", lockToken: "lock-uuid" }],
  ] as const)("tells a webhook whether a message is free, held or already processed (set %s, stored %s)", async (setResult, stored, expected) => {
    vi.mocked(redis.set).mockResolvedValue(setResult);
    vi.mocked(redis.get).mockResolvedValue(stored);

    const result = await acquireMessageProcessing({
      userEmail: "user@example.com",
      messageId: "message-1",
    });

    expect(result).toEqual(expected);
    expect(redis.set).toHaveBeenCalledWith(
      "processing-message:user@example.com:message-1",
      "lock-uuid",
      { ex: 300, nx: true },
    );
  });

  it("remembers a handled message for longer than Gmail keeps history", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    await markMessageProcessed({
      userEmail: "user@example.com",
      messageId: "message-1",
      lockToken: "lock-uuid",
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("SET"'),
      ["processing-message:user@example.com:message-1"],
      ["lock-uuid", "processed", "691200"],
    );
  });

  it("clears an outbound message lock only when the lock is owned", async () => {
    vi.mocked(redis.eval).mockResolvedValue(1);

    const cleared = await clearOutboundMessageLock({
      emailAccountId: "account-1",
      messageId: "message-1",
      lockToken: "lock-token-1",
    });

    expect(cleared).toBe(true);
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('redis.call("DEL"'),
      ["reply-tracker:outbound-message:account-1:message-1"],
      ["lock-token-1"],
    );
  });
});
