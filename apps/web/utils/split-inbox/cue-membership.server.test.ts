import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutedRuleStatus,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getCueMembership } from "@/utils/split-inbox/cue-membership.server";

vi.mock("@/utils/prisma");

const NOW = new Date("2026-10-14T12:00:00Z");

describe("getCueMembership", () => {
  beforeEach(() => {
    prisma.threadTracker.findMany.mockResolvedValue([]);
    prisma.executedRule.findMany.mockResolvedValue([]);
  });

  it("puts conversations still waiting on a reply in Needs reply", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { threadId: "t1", messageId: "m1" },
      { threadId: "t2", messageId: "m2" },
    ] as never);

    const membership = await getCueMembership({
      emailAccountId: "account",
      now: NOW,
    });

    expect(membership.TO_REPLY).toEqual(["m1", "m2"]);
    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account",
          type: ThreadTrackerType.NEEDS_REPLY,
          resolved: false,
        },
      }),
    );
  });

  it("sorts each conversation by what Cue last decided about it", async () => {
    // Newest first, as the query orders them.
    prisma.executedRule.findMany.mockResolvedValue([
      execution("news", "news-2", SystemType.NEWSLETTER),
      execution("promo", "promo-1", SystemType.MARKETING),
      execution("became-fyi", "fyi-2", SystemType.FYI),
      execution("news", "news-1", SystemType.NEWSLETTER),
      execution("became-fyi", "news-0", SystemType.NEWSLETTER),
    ] as never);

    const membership = await getCueMembership({
      emailAccountId: "account",
      now: NOW,
    });

    expect(membership.NEWSLETTER).toEqual(["news-2"]);
    expect(membership.MARKETING).toEqual(["promo-1"]);
    expect(prisma.executedRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: "account",
          status: ExecutedRuleStatus.APPLIED,
          createdAt: { gte: expect.any(Date) },
        }),
      }),
    );
  });

  it("keeps a conversation the user said needs a reply out of Reading", async () => {
    prisma.threadTracker.findMany.mockResolvedValue([
      { threadId: "news", messageId: "news-1" },
    ] as never);
    prisma.executedRule.findMany.mockResolvedValue([
      execution("news", "news-1", SystemType.NEWSLETTER),
    ] as never);

    const membership = await getCueMembership({
      emailAccountId: "account",
      now: NOW,
    });

    expect(membership.TO_REPLY).toEqual(["news-1"]);
    expect(membership.NEWSLETTER).toEqual([]);
  });
});

function execution(threadId: string, messageId: string, systemType: string) {
  return { threadId, messageId, rule: { systemType } };
}
