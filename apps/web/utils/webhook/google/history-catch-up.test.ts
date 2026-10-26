import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { publishToQstashAt } from "@/utils/upstash";
import {
  markGmailHistoryCatchUp,
  raiseGmailHistoryCatchUpTarget,
} from "@/utils/redis/gmail-history-catch-up";
import {
  nudgeGmailHistoryCatchUp,
  scheduleGmailHistoryCatchUp,
} from "./history-catch-up";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn() } }));
vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/utils/redis/gmail-history-catch-up", () => ({
  markGmailHistoryCatchUp: vi.fn().mockResolvedValue(undefined),
  raiseGmailHistoryCatchUpTarget: vi.fn().mockResolvedValue(undefined),
}));

const logger = createTestLogger();

describe("nudgeGmailHistoryCatchUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.set).mockResolvedValue("OK");
    prisma.emailAccount.findUnique.mockResolvedValue({
      lastSyncedHistoryId: "1000",
    } as any);
  });

  it("schedules a catch-up when the mailbox has mail the server has not processed", async () => {
    await nudgeGmailHistoryCatchUp({
      emailAccountId: "account-1",
      mailboxHistoryId: "1500",
      logger,
    });

    expect(markGmailHistoryCatchUp).toHaveBeenCalledWith(
      "account-1",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "/api/google/webhook/catch-up",
        body: { emailAccountId: "account-1", historyId: "1500" },
      }),
    );
  });

  it("does nothing when the server has already processed that history", async () => {
    await nudgeGmailHistoryCatchUp({
      emailAccountId: "account-1",
      mailboxHistoryId: "1000",
      logger,
    });

    expect(markGmailHistoryCatchUp).not.toHaveBeenCalled();
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("nudges an account at most once per debounce window", async () => {
    vi.mocked(redis.set).mockResolvedValue(null);

    await nudgeGmailHistoryCatchUp({
      emailAccountId: "account-1",
      mailboxHistoryId: "1500",
      logger,
    });

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });
});

describe("scheduleGmailHistoryCatchUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records how far the account must catch up, since deliveries in one window share a body", async () => {
    await scheduleGmailHistoryCatchUp({
      emailAccountId: "account-1",
      historyId: "1500",
      logger,
    });

    expect(raiseGmailHistoryCatchUpTarget).toHaveBeenCalledWith(
      "account-1",
      "1500",
      expect.anything(),
    );
    expect(publishToQstashAt).toHaveBeenCalled();
  });

  // Delivery windows are 90s wide, so where the retry falls in its window
  // decides whether the early re-run would land in the same one.
  it.each([
    ["just after a window boundary", 500],
    ["mid-window", 45_000],
  ])("doesn't defer a catch-up that arrived a little early into its own delivery (retry %s)", async (_name, offsetInWindow) => {
    const retryAt = new Date(
      Math.floor(Date.UTC(2030, 0, 1) / 90_000) * 90_000 + offsetInWindow,
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(retryAt.getTime() - 10 * 60_000);
      await scheduleGmailHistoryCatchUp({
        emailAccountId: "account-1",
        historyId: "1500",
        retryAt,
        logger,
      });
      // That catch-up arrives 2s before its retry is due, and the message
      // fails again.
      vi.setSystemTime(retryAt.getTime() - 2000);
      await scheduleGmailHistoryCatchUp({
        emailAccountId: "account-1",
        historyId: "1500",
        retryAt,
        logger,
      });

      const [first, second] = vi
        .mocked(publishToQstashAt)
        .mock.calls.map(([delivery]) => delivery.deduplicationId);
      expect(second).not.toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });
});
