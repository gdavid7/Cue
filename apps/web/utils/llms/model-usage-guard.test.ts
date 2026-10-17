import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertTrialAiUsageAllowed,
  getUserTrialAiUsageLimitStatus,
  shouldForceNanoModel,
  TRIAL_AI_LIMIT_REACHED_MESSAGE,
} from "@/utils/llms/model-usage-guard";
import { getWeeklyUsageCostByBucket } from "@/utils/redis/usage";
import { env } from "@/env";
import prisma from "@/utils/__mocks__/prisma";
import { SafeError } from "@/utils/error";
import { redis } from "@/utils/redis";
import { sendActionRequiredEmail } from "@inboxzero/transactional-email";
import { createUnsubscribeToken } from "@/utils/unsubscribe";

vi.mock("@/utils/redis/usage", () => ({
  getWeeklyUsageCostByBucket: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    set: vi.fn(),
    del: vi.fn(),
  },
}));

vi.mock("@/utils/prisma");

// These cases are about the limits, not the per-instance memo of spend.
vi.mock("@/utils/memo-cache", () => ({
  createMemoCache: () => ({
    get: (_key: string, load: () => Promise<unknown>) => load(),
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("@inboxzero/transactional-email", () => ({
  sendActionRequiredEmail: vi.fn(),
}));

vi.mock("@/utils/unsubscribe", () => ({
  createUnsubscribeToken: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    AI_NANO_WEEKLY_SPEND_LIMIT_USD: undefined,
    AI_TRIAL_WEEKLY_SPEND_LIMIT_USD: undefined,
    NEXT_PUBLIC_BASE_URL: "https://example.com",
    RESEND_FROM_EMAIL: "support@example.com",
    NANO_LLMS: undefined,
  },
}));

describe("shouldForceNanoModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = undefined;
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = undefined;
    vi.mocked(env).NANO_LLMS = undefined;
  });

  it("does not force nano when the spend limit is not configured", async () => {
    const result = await shouldForceNanoModel({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-1",
    });

    expect(result.shouldForce).toBe(false);
    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
  });

  it("does not force nano for users with their own API key", async () => {
    vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = 3;
    vi.mocked(env).NANO_LLMS = "openai:gpt-5.4-nano";

    const result = await shouldForceNanoModel({
      userEmail: "user@example.com",
      hasUserApiKey: true,
      label: "assistant-chat",
    });

    expect(result.shouldForce).toBe(false);
    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
  });

  it("does not force nano when nano model is not configured", async () => {
    vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = 3;

    const result = await shouldForceNanoModel({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-1",
    });

    expect(result.shouldForce).toBe(false);
    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
  });

  it("forces nano when weekly spend meets the configured limit", async () => {
    vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = 3;
    vi.mocked(env).NANO_LLMS = "openai:gpt-5.4-nano";
    mockWeeklySpend({ interactive: 3.25, triage: 0 });

    const result = await shouldForceNanoModel({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-1",
    });

    expect(result.shouldForce).toBe(true);
    expect(result.weeklySpendUsd).toBe(3.25);
    expect(result.weeklyLimitUsd).toBe(3);
  });

  it("does not force nano when weekly spend is below the limit", async () => {
    vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = 3;
    vi.mocked(env).NANO_LLMS = "openai:gpt-5.4-nano";
    mockWeeklySpend({ interactive: 2.99, triage: 0 });

    const result = await shouldForceNanoModel({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "assistant-chat",
      userId: "user-1",
    });

    expect(result.shouldForce).toBe(false);
    expect(result.weeklySpendUsd).toBe(2.99);
    expect(result.weeklyLimitUsd).toBe(3);
  });

  describe("spend buckets", () => {
    const claimedKeys = new Set<string>();
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-14T12:00:00.000Z"));
      vi.mocked(env).AI_NANO_WEEKLY_SPEND_LIMIT_USD = 3;
      vi.mocked(env).NANO_LLMS = "openai:gpt-5.4-nano";
      claimedKeys.clear();
      vi.mocked(redis.set).mockImplementation((async (key: string) => {
        if (claimedKeys.has(key)) return null;
        claimedKeys.add(key);
        return "OK";
      }) as never);
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.useRealTimers();
      warnSpy.mockRestore();
    });

    it("keeps triage on its model when chat spend is over the limit", async () => {
      mockWeeklySpend({ interactive: 12, triage: 1 });

      const triage = await shouldForceNanoModel(guardOptions("Choose rule"));
      const interactive = await shouldForceNanoModel(
        guardOptions("chat-compaction"),
      );

      expect(triage).toMatchObject({
        shouldForce: false,
        spendBucket: "triage",
      });
      expect(interactive).toMatchObject({
        shouldForce: true,
        spendBucket: "interactive",
        weeklySpendUsd: 12,
        weeklyLimitUsd: 3,
      });
    });

    it("downgrades only triage once triage spend passes its own cap", async () => {
      mockWeeklySpend({ interactive: 1, triage: 9.5 });

      for (const label of [
        "Choose rule",
        "Determine thread status",
        "Cold email check",
        "Draft reply",
        "Summarize email",
      ]) {
        expect(await shouldForceNanoModel(guardOptions(label))).toMatchObject({
          shouldForce: true,
          spendBucket: "triage",
          weeklySpendUsd: 9.5,
          weeklyLimitUsd: 9,
        });
      }
      expect(
        await shouldForceNanoModel(guardOptions("chat-compaction")),
      ).toMatchObject({ shouldForce: false, spendBucket: "interactive" });
    });

    it("warns once per user per week for each bucket over its limit", async () => {
      mockWeeklySpend({ interactive: 4, triage: 10 });

      for (let i = 0; i < 3; i++) {
        await shouldForceNanoModel(guardOptions("Choose rule"));
        await shouldForceNanoModel(guardOptions("chat-compaction"));
      }

      await flushWarnings();
      expect(getBucketWarnings()).toEqual(["triage", "interactive"]);

      vi.setSystemTime(new Date("2026-10-21T12:00:00.000Z"));
      await shouldForceNanoModel(guardOptions("Choose rule"));
      await shouldForceNanoModel(guardOptions("Choose rule"));

      await flushWarnings();
      expect(getBucketWarnings()).toEqual(["triage", "interactive", "triage"]);
    });

    // The warning is fire-and-forget, so let its Redis claim settle.
    function flushWarnings() {
      return new Promise((resolve) => setTimeout(resolve, 0));
    }

    function getBucketWarnings() {
      return warnSpy.mock.calls
        .map(([message]: unknown[]) => String(message))
        .filter((message: string) =>
          message.includes("spend bucket over limit"),
        )
        .map((message: string) =>
          message.includes('"spendBucket": "triage"')
            ? "triage"
            : "interactive",
        );
    }
  });
});

function guardOptions(label: string) {
  return {
    userEmail: "user@example.com",
    hasUserApiKey: false,
    label,
    userId: "user-1",
    emailAccountId: "account-1",
  };
}

function mockWeeklySpend({
  interactive,
  triage,
}: {
  interactive: number;
  triage: number;
}) {
  vi.mocked(getWeeklyUsageCostByBucket).mockResolvedValue({
    total: interactive + triage,
    interactive,
    triage,
  });
}

describe("assertTrialAiUsageAllowed", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = undefined;
  });

  it("does nothing when trial spend limit is not configured", async () => {
    await assertTrialAiUsageAllowed({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "Choose rule",
      userId: "user-1",
      emailAccountId: "account-1",
    });

    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not block users with their own API key", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;

    await assertTrialAiUsageAllowed({
      userEmail: "user@example.com",
      hasUserApiKey: true,
      label: "Choose rule",
      userId: "user-1",
      emailAccountId: "account-1",
    });

    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("does not block paid subscriptions over the trial limit", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;
    mockWeeklySpend({ interactive: 3, triage: 0 });
    prisma.user.findUnique.mockResolvedValue({
      email: "user@example.com",
      emailAccounts: [{ email: "account@example.com" }],
      premium: {
        stripeSubscriptionStatus: "active",
        lemonSubscriptionStatus: null,
      },
    } as any);

    await assertTrialAiUsageAllowed({
      userEmail: "user@example.com",
      hasUserApiKey: false,
      label: "Choose rule",
      userId: "user-1",
      emailAccountId: "account-1",
    });

    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(sendActionRequiredEmail).not.toHaveBeenCalled();
  });

  it("blocks trial users over the spend limit and sends an upgrade email once", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;
    mockWeeklySpend({ interactive: 3, triage: 0 });
    vi.mocked(redis.set).mockResolvedValue("OK");
    vi.mocked(createUnsubscribeToken).mockResolvedValue("unsubscribe-token");
    prisma.user.findUnique.mockResolvedValue({
      email: "user@example.com",
      emailAccounts: [{ email: "account@example.com" }],
      premium: {
        stripeSubscriptionStatus: "trialing",
        lemonSubscriptionStatus: null,
      },
    } as any);

    await expect(
      assertTrialAiUsageAllowed({
        userEmail: "user@example.com",
        hasUserApiKey: false,
        label: "Choose rule",
        userId: "user-1",
        emailAccountId: "account-1",
      }),
    ).rejects.toThrow(SafeError);

    expect(getWeeklyUsageCostByBucket).toHaveBeenCalledWith({
      userId: "user-1",
      legacyEmails: ["user@example.com", "account@example.com"],
    });
    expect(redis.set).toHaveBeenCalledWith(
      "trial-ai-limit-notification:user-1",
      expect.any(String),
      { ex: 5_184_000, nx: true },
    );
    expect(sendActionRequiredEmail).toHaveBeenCalledWith({
      from: "support@example.com",
      to: "user@example.com",
      emailProps: {
        baseUrl: "https://example.com",
        email: "user@example.com",
        unsubscribeToken: "unsubscribe-token",
        errorType: "Trial AI Limit Reached",
        errorMessage: TRIAL_AI_LIMIT_REACHED_MESSAGE,
        actionUrl: "/premium",
        actionLabel: "Start paid plan now",
      },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("does not resend a trial limit email when the notification marker exists", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;
    mockWeeklySpend({ interactive: 3, triage: 0 });
    vi.mocked(redis.set).mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({
      email: "user@example.com",
      emailAccounts: [{ email: "account@example.com" }],
      premium: {
        stripeSubscriptionStatus: "trialing",
        lemonSubscriptionStatus: null,
      },
    } as any);

    await expect(
      assertTrialAiUsageAllowed({
        userEmail: "user@example.com",
        hasUserApiKey: false,
        label: "Choose rule",
        userId: "user-1",
        emailAccountId: "account-1",
      }),
    ).rejects.toThrow(SafeError);

    expect(sendActionRequiredEmail).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("getUserTrialAiUsageLimitStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = undefined;
  });

  it("returns allowed when trial spend limit is not configured", async () => {
    const status = await getUserTrialAiUsageLimitStatus({
      userId: "user-1",
    });

    expect(status).toEqual({ status: "allowed" });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns allowed for paid users without checking usage", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;
    prisma.user.findUnique.mockResolvedValue({
      email: "user@example.com",
      aiApiKey: null,
      emailAccounts: [{ email: "account@example.com" }],
      premium: {
        stripeSubscriptionStatus: "active",
        lemonSubscriptionStatus: null,
      },
    } as any);

    const status = await getUserTrialAiUsageLimitStatus({
      userId: "user-1",
    });

    expect(status).toEqual({ status: "allowed" });
    expect(getWeeklyUsageCostByBucket).not.toHaveBeenCalled();
  });

  it("returns a dynamic trial limit status for trial users over the limit", async () => {
    vi.mocked(env).AI_TRIAL_WEEKLY_SPEND_LIMIT_USD = 2;
    mockWeeklySpend({ interactive: 3, triage: 0 });
    prisma.user.findUnique.mockResolvedValue({
      email: "user@example.com",
      aiApiKey: null,
      emailAccounts: [{ email: "account@example.com" }],
      premium: {
        stripeSubscriptionStatus: "trialing",
        lemonSubscriptionStatus: null,
      },
    } as any);

    const status = await getUserTrialAiUsageLimitStatus({
      userId: "user-1",
    });

    expect(getWeeklyUsageCostByBucket).toHaveBeenCalledWith({
      userId: "user-1",
      legacyEmails: ["user@example.com", "account@example.com"],
    });
    expect(status).toEqual({
      status: "trial_ai_limit_reached",
      message: TRIAL_AI_LIMIT_REACHED_MESSAGE,
      weeklySpendUsd: 3,
      weeklyLimitUsd: 2,
    });
  });
});
