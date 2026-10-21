import { subDays } from "date-fns/subDays";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  enforceDraftSentTextRetention,
  enforceConfiguredReasoningRetention,
  enforceReasoningRetention,
} from "./reasoning-retention";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

describe("enforceReasoningRetention", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prisma.executedRule.updateMany.mockResolvedValue({ count: 1 });
    prisma.documentFiling.updateMany.mockResolvedValue({ count: 2 });
    prisma.draftSendLog.updateMany.mockResolvedValue({ count: 3 });
    prisma.composeAssistReply.deleteMany.mockResolvedValue({ count: 4 });
    prisma.composeAssistReply.updateMany.mockResolvedValue({ count: 5 });
  });

  it("redacts stale reasoning fields and returns per-table counts", async () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    const cutoff = subDays(now, 90);

    await expect(
      enforceReasoningRetention({ days: 90, logger, now }),
    ).resolves.toEqual({
      skipped: false,
      cutoff,
      executedRules: 1,
      documentFilings: 2,
    });

    expect(prisma.executedRule.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        reason: { not: null },
      },
      data: { reason: null },
    });

    expect(prisma.documentFiling.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        reasoning: { not: null },
      },
      data: { reasoning: null },
    });

    expect(prisma.executedAction.updateMany).not.toHaveBeenCalled();
    expect(prisma.scheduledAction.updateMany).not.toHaveBeenCalled();
    expect(prisma.digestItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.groupItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.draftSendLog.updateMany).not.toHaveBeenCalled();
    expect(prisma.automationJobRun.updateMany).not.toHaveBeenCalled();
  });

  it("redacts stale captured sent draft text", async () => {
    const now = new Date("2026-05-05T12:00:00.000Z");
    const cutoff = subDays(now, 14);

    await expect(
      enforceDraftSentTextRetention({ days: 14, logger, now }),
    ).resolves.toEqual({
      cutoff,
      draftSendLogs: 3,
      unsentComposeAssistReplies: 4,
      sentComposeAssistReplies: 5,
    });

    expect(prisma.draftSendLog.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: cutoff },
        OR: [
          { sentText: { not: null } },
          { replyMemorySentText: { not: null } },
        ],
      },
      data: {
        sentText: null,
        replyMemorySentText: null,
      },
    });
  });

  it("deletes Cue's suggestions for replies never sent, and clears the text of sent ones", async () => {
    const now = new Date("2026-05-05T12:00:00.000Z");

    await enforceDraftSentTextRetention({ days: 14, logger, now });

    expect(prisma.composeAssistReply.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: subDays(now, 7) }, draftSendLog: null },
    });
    expect(prisma.composeAssistReply.updateMany).toHaveBeenCalledWith({
      where: {
        draftSendLog: { is: { createdAt: { lt: subDays(now, 14) } } },
        NOT: { outcomes: { equals: [] } },
      },
      data: { outcomes: [] },
    });
  });

  it("never keeps unsent suggestions longer than the configured retention", async () => {
    const now = new Date("2026-05-05T12:00:00.000Z");

    await enforceDraftSentTextRetention({ days: 2, logger, now });

    expect(prisma.composeAssistReply.deleteMany).toHaveBeenCalledWith({
      where: { updatedAt: { lt: subDays(now, 2) }, draftSendLog: null },
    });
  });

  it("skips without database writes when retention is not configured", async () => {
    await expect(
      enforceConfiguredReasoningRetention({ days: undefined, logger }),
    ).resolves.toEqual({
      skipped: true,
      reason: "not-configured",
    });

    expectNoRetentionWrites();
  });

  it("rejects invalid retention windows", async () => {
    await expect(
      enforceReasoningRetention({ days: -1, logger }),
    ).rejects.toThrow(
      "Reasoning retention days must be a non-negative integer",
    );

    expectNoRetentionWrites();
  });

  it("rejects invalid draft sent text retention windows", async () => {
    await expect(
      enforceDraftSentTextRetention({ days: -1, logger }),
    ).rejects.toThrow(
      "Draft sent text retention days must be a non-negative integer",
    );

    expectNoRetentionWrites();
  });
});

function expectNoRetentionWrites() {
  expect(prisma.executedRule.updateMany).not.toHaveBeenCalled();
  expect(prisma.executedAction.updateMany).not.toHaveBeenCalled();
  expect(prisma.scheduledAction.updateMany).not.toHaveBeenCalled();
  expect(prisma.digestItem.updateMany).not.toHaveBeenCalled();
  expect(prisma.groupItem.updateMany).not.toHaveBeenCalled();
  expect(prisma.documentFiling.updateMany).not.toHaveBeenCalled();
  expect(prisma.draftSendLog.updateMany).not.toHaveBeenCalled();
  expect(prisma.automationJobRun.updateMany).not.toHaveBeenCalled();
}
