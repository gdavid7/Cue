import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { publishToQstashAt } from "@/utils/upstash";
import { markGmailHistoryCatchUp } from "@/utils/redis/gmail-history-catch-up";
import { nudgeGmailHistoryCatchUp } from "./history-catch-up";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn() } }));
vi.mock("@/utils/upstash", () => ({
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/utils/redis/gmail-history-catch-up", () => ({
  markGmailHistoryCatchUp: vi.fn().mockResolvedValue(undefined),
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
