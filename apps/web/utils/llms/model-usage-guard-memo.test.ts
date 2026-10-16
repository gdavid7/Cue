import { beforeEach, describe, expect, it, vi } from "vitest";
import { shouldForceNanoModel } from "@/utils/llms/model-usage-guard";
import { getWeeklyUsageCost } from "@/utils/redis/usage";

vi.mock("@/utils/redis/usage", () => ({ getWeeklyUsageCost: vi.fn() }));
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
    vi.mocked(getWeeklyUsageCost).mockResolvedValue(1);
    const options = {
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-memo",
    };

    await shouldForceNanoModel(options);
    const second = await shouldForceNanoModel(options);

    expect(second).toMatchObject({ shouldForce: false, weeklySpendUsd: 1 });
    expect(getWeeklyUsageCost).toHaveBeenCalledOnce();
  });

  it("fails open, and retries, when the spend can't be read", async () => {
    vi.mocked(getWeeklyUsageCost)
      .mockRejectedValueOnce(new Error("limit exceeded"))
      .mockResolvedValue(5);
    const options = {
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-down",
    };

    expect(await shouldForceNanoModel(options)).toMatchObject({
      shouldForce: false,
    });
    expect(await shouldForceNanoModel(options)).toMatchObject({
      shouldForce: true,
    });
  });
});
