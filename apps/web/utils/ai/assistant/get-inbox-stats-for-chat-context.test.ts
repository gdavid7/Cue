import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { getInboxStatsForChatContext } from "./get-inbox-stats-for-chat-context";

vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider");

const logger = createTestLogger();

describe("getInboxStatsForChatContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks a few accounts at once and sums only those that answer within the budget", async () => {
    prisma.emailAccount.findMany.mockResolvedValue(
      Array.from({ length: 6 }, (_, index) => ({
        id: `account-${index + 2}`,
        email: `account-${index + 2}@example.com`,
        name: null,
        image: null,
        includeInAllAccounts: true,
        account: { provider: "google" },
      })) as never,
    );
    let running = 0;
    let mostAtOnce = 0;
    vi.mocked(createEmailProvider).mockImplementation(
      async () =>
        ({
          getInboxStats: async () => {
            running += 1;
            mostAtOnce = Math.max(mostAtOnce, running);
            await new Promise((resolve) => setTimeout(resolve, 1500));
            running -= 1;
            return { total: 10, unread: 1 };
          },
        }) as never,
    );

    const pending = getInboxStatsForChatContext({
      userId: "user-1",
      emailAccountId: "account-1",
      provider: "google",
      logger,
    });
    await vi.advanceTimersByTimeAsync(2000);

    // The first three answer at 1.5 s; the next three would answer at 3 s.
    await expect(pending).resolves.toEqual({ total: 30, unread: 3 });
    expect(mostAtOnce).toBe(3);

    await vi.advanceTimersByTimeAsync(5000);
    // Accounts still queued at the deadline are never asked.
    expect(createEmailProvider).toHaveBeenCalledTimes(6);
  });
});
