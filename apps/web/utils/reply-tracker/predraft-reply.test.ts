import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionType,
  DraftEmailStatus,
  ExecutedActionStatus,
  ExecutedRuleStatus,
  SystemType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getMockMessage } from "@/__tests__/helpers";
import type { RunRulesResult } from "@/utils/ai/choose-rule/run-rules";
import type { EmailProvider } from "@/utils/email/types";
import { currentGmailQuotaContext } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { predraftReply } from "@/utils/reply-tracker/predraft-reply";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: {
    REDIS_HTTP_URL: "https://redis.example.com",
    REDIS_HTTP_TOKEN: "token",
  },
}));

const { counters, claims, suggestReply, getSuggestedReplySettings } =
  vi.hoisted(() => ({
    counters: new Map<string, number>(),
    claims: new Set<string>(),
    suggestReply: vi.fn(),
    getSuggestedReplySettings: vi.fn(),
  }));
vi.mock("@/utils/redis", () => ({
  redis: {
    eval: vi.fn(async (_script: string, keys: string[]) => {
      const count = (counters.get(keys[0]) ?? 0) + 1;
      counters.set(keys[0], count);
      return count;
    }),
    set: vi.fn(async (key: string) => {
      if (claims.has(key)) return null;
      claims.add(key);
      return "OK";
    }),
  },
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  suggestReply,
  getSuggestedReplySettings,
}));

const REPLY = "Friday works. See you at 10.";
const NOW = new Date("2026-10-19T12:00:00Z");
const emailAccount = { id: "account-1", email: "user@example.com" };
const provider = {} as EmailProvider;
const toReplyResult: RunRulesResult = {
  rule: { systemType: SystemType.TO_REPLY } as RunRulesResult["rule"],
  status: ExecutedRuleStatus.APPLIED,
  createdAt: NOW,
};

describe("predraftReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    counters.clear();
    claims.clear();
    getSuggestedReplySettings.mockResolvedValue({
      draftReplies: "on",
      webLookupEnabled: false,
    });
    prisma.executedRule.findFirst.mockResolvedValue({
      id: "executed-rule-1",
    } as never);
    prisma.executedAction.findFirst.mockResolvedValue(null);
    prisma.executedAction.create.mockResolvedValue({
      id: "predraft-1",
    } as never);
    suggestReply.mockResolvedValue({
      status: "suggested",
      reply: REPLY,
      citations: [],
    });
  });

  it("keeps the suggestion where a rule's would wait, marked as a pre-draft", async () => {
    const logger = createScopedLogger("predraft-test");
    const info = vi.spyOn(logger, "info");

    const outcome = await run({ logger });

    expect(outcome).toBe("drafted");
    expect(suggestReply).toHaveBeenCalledWith(
      expect.objectContaining({ source: "predraft", threadId: "thread-1" }),
    );
    expect(prisma.executedAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          executedRuleId: "executed-rule-1",
          type: ActionType.DRAFT_EMAIL,
          content: REPLY,
          draftId: null,
          draftStatus: DraftEmailStatus.PENDING,
          executionStatus: ExecutedActionStatus.SUCCEEDED,
          replySuggestionPredrafted: true,
        }),
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "Reply suggestion funnel",
      expect.objectContaining({
        stage: "generated",
        source: "predraft",
        executedActionId: "predraft-1",
      }),
    );
    // One cost line, with no part of the mail or the reply in it.
    const costLines = info.mock.calls.filter(
      ([message]) => message === "Reply pre-draft",
    );
    expect(costLines).toHaveLength(1);
    expect(costLines[0]?.[1]).toEqual(
      expect.objectContaining({
        outcome: "drafted",
        estimatedCost: expect.any(Number),
        totalTokens: expect.any(Number),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain("Friday");
  });

  it("skips the 21st pre-draft of the day", async () => {
    const outcomes = [];
    for (let i = 0; i < 21; i++)
      outcomes.push(await run({ messageId: `message-${i}` }));

    expect(outcomes.slice(0, 20).every((o) => o === "drafted")).toBe(true);
    expect(outcomes[20]).toBe("daily-cap");
    expect(suggestReply).toHaveBeenCalledTimes(20);
    expect(prisma.executedAction.create).toHaveBeenCalledTimes(20);
  });

  it("writes nothing when draft replies are off", async () => {
    getSuggestedReplySettings.mockResolvedValue({
      draftReplies: "off",
      webLookupEnabled: false,
    });

    expect(await run()).toBe("draft-replies-not-on");
    expect(suggestReply).not.toHaveBeenCalled();
    expect(prisma.executedAction.create).not.toHaveBeenCalled();
    expect(counters.size).toBe(0);
  });

  it("leaves a message alone when a rule already suggested a reply to it", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      id: "rule-suggestion",
    } as never);

    expect(await run()).toBe("already-suggested");
    expect(suggestReply).not.toHaveBeenCalled();
    expect(prisma.executedAction.create).not.toHaveBeenCalled();
    // A skipped message doesn't use up one of the day's slots.
    expect(counters.size).toBe(0);
  });

  it("does nothing for mail Cue didn't file To Reply", async () => {
    const outcome = await run({
      results: [
        {
          rule: { systemType: SystemType.FYI } as RunRulesResult["rule"],
          status: ExecutedRuleStatus.APPLIED,
          createdAt: NOW,
        },
      ],
    });

    expect(outcome).toBe("not-needed");
    expect(getSuggestedReplySettings).not.toHaveBeenCalled();
    expect(suggestReply).not.toHaveBeenCalled();
  });

  it("stores nothing when the facts for a reply aren't there", async () => {
    suggestReply.mockResolvedValue({
      status: "insufficient",
      missing: "The renewal price",
      unsupported: [],
      webQuery: "",
    });

    expect(await run()).toBe("no-suggestion");
    expect(prisma.executedAction.create).not.toHaveBeenCalled();
  });

  // D-086: nobody asked for it, so it waits behind sync and the user.
  it("reads Gmail at background priority", async () => {
    let priority: string | undefined;
    suggestReply.mockImplementation(async () => {
      priority = currentGmailQuotaContext().priority;
      return { status: "suggested", reply: REPLY, citations: [] };
    });

    await run();

    expect(priority).toBe("background");
  });

  it("writes one pre-draft when two webhooks deliver the same message", async () => {
    const outcomes = await Promise.all([run(), run()]);

    expect(outcomes.sort()).toEqual(["already-suggested", "drafted"]);
    expect(suggestReply).toHaveBeenCalledTimes(1);
    const [key] = claims;
    expect(key).toMatch(/^predraft-message:v1:account-1:[0-9a-f]{64}$/);
    expect(key).not.toContain("message-1");
  });

  it("reports a failure instead of throwing", async () => {
    const logger = createScopedLogger("predraft-test");
    const error = vi.spyOn(logger, "error");
    suggestReply.mockRejectedValue(new Error("model down"));

    expect(await run({ logger })).toBe("failed");
    expect(error).toHaveBeenCalledWith("Reply pre-draft failed", {
      error: expect.any(Error),
    });
  });
});

function run({
  results = [toReplyResult],
  logger = createScopedLogger("predraft-test"),
  messageId = "message-1",
}: {
  results?: RunRulesResult[];
  logger?: ReturnType<typeof createScopedLogger>;
  messageId?: string;
} = {}) {
  return predraftReply({
    emailAccount,
    message: getMockMessage({ id: messageId, threadId: "thread-1" }),
    results,
    provider,
    logger,
    now: NOW,
  });
}
