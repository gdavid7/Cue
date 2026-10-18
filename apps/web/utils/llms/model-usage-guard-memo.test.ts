import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldForceNanoModel } from "@/utils/llms/model-usage-guard";
import { getWeeklyUsageCostByBucket } from "@/utils/redis/usage";

vi.mock("@/utils/redis/usage", () => ({
  getWeeklyUsageCostByBucket: vi.fn(),
}));
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn(), del: vi.fn() } }));
vi.mock("@/utils/prisma");
vi.mock("@inboxzero/transactional-email", () => ({
  sendActionRequiredEmail: vi.fn(),
}));
vi.mock("@/env", () => ({
  env: {
    AI_NANO_WEEKLY_SPEND_LIMIT_USD: 3,
    NANO_LLMS: "openai:gpt-5.4-nano",
  },
}));

describe("weekly spend guard reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A chat turn or a processed email makes several AI calls in a row; the
  // spend limit is a weekly budget, so a minute-old total is close enough.
  it("reads a user's weekly spend once a minute per instance", async () => {
    vi.mocked(getWeeklyUsageCostByBucket).mockResolvedValue(spend(1));
    const options = {
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-memo",
    };

    await shouldForceNanoModel(options);
    const second = await shouldForceNanoModel(options);

    expect(second).toMatchObject({ shouldForce: false, weeklySpendUsd: 1 });
    expect(getWeeklyUsageCostByBucket).toHaveBeenCalledOnce();
  });

  // Spend that can't be read is spend that can't be capped: the cheap tier
  // keeps AI working without letting an outage run up the bill.
  it("falls back to the nano model, and retries later, when the spend can't be read", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(getWeeklyUsageCostByBucket)
      .mockRejectedValueOnce(new Error("limit exceeded"))
      .mockResolvedValue(spend(1));
    const options = {
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "chat-compaction",
      userId: "user-down",
    };

    try {
      expect(await shouldForceNanoModel(options)).toMatchObject({
        shouldForce: true,
        reason: "spend_unreadable",
        weeklySpendUsd: null,
      });
      // Each call doesn't wait on a store that just refused.
      expect(await shouldForceNanoModel(options)).toMatchObject({
        shouldForce: true,
        reason: "spend_unreadable",
      });
      expect(getWeeklyUsageCostByBucket).toHaveBeenCalledOnce();

      vi.advanceTimersByTime(30_000);
      expect(await shouldForceNanoModel(options)).toMatchObject({
        shouldForce: false,
        weeklySpendUsd: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("warns about an unreadable spend once a minute per instance, not per call", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // Clear of any warning an earlier case left in this instance's minute.
    vi.setSystemTime(Date.now() + 365 * 24 * 60 * 60_000);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getWeeklyUsageCostByBucket).mockRejectedValue(
      new Error("max requests limit exceeded"),
    );
    const options = {
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "chat-compaction",
      userId: "user-capped",
    };
    const warnings = () =>
      warn.mock.calls.filter(([line]) =>
        String(line).includes("Failed to evaluate nano model guard"),
      ).length;

    try {
      for (let call = 0; call < 5; call++) await shouldForceNanoModel(options);
      expect(warnings()).toBe(1);

      vi.advanceTimersByTime(60_000);
      await shouldForceNanoModel(options);
      expect(warnings()).toBe(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

function spend(interactive: number) {
  return { total: interactive, interactive, triage: 0 };
}
