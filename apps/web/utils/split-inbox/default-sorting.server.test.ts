import { beforeEach, describe, expect, it, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { createEmailProvider } from "@/utils/email/provider";
import { ensureDefaultCueSorting } from "@/utils/split-inbox/default-sorting.server";
import { getInboxStyleHintId } from "@/utils/split-inbox/inbox-styles";
import { createMailSplit } from "@/utils/split-inbox/splits.server";

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/split-inbox/splits.server", () => ({
  createMailSplit: vi.fn(),
  updateMailSplit: vi.fn(),
}));
vi.mock("@/utils/ai/choose-rule/bulk-process-emails", () => ({
  bulkProcessInboxEmails: vi.fn(),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: vi.fn(async () => ({ id: "account" })),
}));

const logger = createTestLogger();
const MAILBOX = {
  emailAccountId: "account",
  provider: "google",
  logger,
};
const REPLY_TRACKING_RULES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
];

type MarkerField = "defaultSortingCheckedAt" | "defaultSortingAppliedAt";
// The mailbox row's markers, with the conditional updates Postgres applies.
let markers: Record<MarkerField, Date | null>;
// Rules in the database, so a second sync sees what the first one created.
let ruleRows: { id: string; systemType: SystemType; name: string }[];

describe("ensureDefaultCueSorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    markers = { defaultSortingCheckedAt: null, defaultSortingAppliedAt: null };
    ruleRows = [];

    prisma.emailAccount.updateMany.mockImplementation((async (args: {
      where: { id: string } & Partial<Record<MarkerField, Date | null>>;
      data: Partial<Record<MarkerField, Date | null>>;
    }) => {
      const { id: _, ...conditions } = args.where;
      const matches = Object.entries(conditions).every(
        ([field, value]) =>
          (markers[field as MarkerField]?.getTime() ?? null) ===
          (value?.getTime() ?? null),
      );
      if (!matches) return { count: 0 };
      Object.assign(markers, args.data);
      return { count: 1 };
    }) as never);
    prisma.emailAccount.findUnique.mockImplementation((async () => ({
      ...markers,
    })) as never);
    prisma.rule.findFirst.mockImplementation(
      (async () => ruleRows[0] ?? null) as never,
    );
    prisma.rule.findMany.mockImplementation((async () => [
      ...ruleRows.map((rule) => ({ ...rule, enabled: true, actions: [] })),
    ]) as never);
    prisma.executedRule.findFirst.mockResolvedValue(null);
    prisma.rule.createManyAndReturn.mockImplementation((async (args: {
      data: { systemType: SystemType; name: string }[];
    }) => {
      const inserted = args.data
        .filter(
          (rule) => !ruleRows.some((row) => row.systemType === rule.systemType),
        )
        .map((rule) => ({
          id: `new-${rule.systemType}`,
          systemType: rule.systemType,
          name: rule.name,
        }));
      ruleRows.push(...inserted);
      return inserted.map(({ id }) => ({ id }));
    }) as never);
  });

  it("gives a mailbox with no rules and no choice Cue's default sorting", async () => {
    const applied = await ensureDefaultCueSorting(MAILBOX);

    expect(applied).toBe(true);
    expect(createdRules().map((rule) => rule.systemType)).toEqual(
      REPLY_TRACKING_RULES,
    );
    for (const rule of createdRules()) {
      expect(rule.enabled).toBe(true);
      expect(rule.emailAccountId).toBe("account");
    }
    expect(markers.defaultSortingCheckedAt).toBeInstanceOf(Date);
    expect(markers.defaultSortingAppliedAt).toBeInstanceOf(Date);
  });

  it("sorts only recent inbox mail, in the background", async () => {
    await ensureDefaultCueSorting(MAILBOX);
    expect(bulkProcessInboxEmails).not.toHaveBeenCalled();

    await runAfterCallbacks();

    expect(bulkProcessInboxEmails).toHaveBeenCalledTimes(1);
    expect(vi.mocked(bulkProcessInboxEmails).mock.calls[0][0]).toMatchObject({
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      priority: "background",
      ruleIds: REPLY_TRACKING_RULES.map((type) => `new-${type}`),
    });
  });

  it("writes nothing to the mailbox: no labels, filters, tabs or actions", async () => {
    await ensureDefaultCueSorting(MAILBOX);

    for (const rule of createdRules()) {
      expect(rule).not.toHaveProperty("actions");
    }
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(createMailSplit).not.toHaveBeenCalled();
    expect(prisma.action.create).not.toHaveBeenCalled();
    expect(prisma.action.createMany).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
  });

  it("only does it once, so rules deleted afterwards stay deleted", async () => {
    await ensureDefaultCueSorting(MAILBOX);
    ruleRows = [];
    vi.mocked(prisma.rule.createManyAndReturn).mockClear();

    const appliedAgain = await ensureDefaultCueSorting(MAILBOX);

    expect(appliedAgain).toBe(false);
    expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
  });

  it("applies once when syncs race for the same mailbox", async () => {
    const results = await Promise.all([
      ensureDefaultCueSorting(MAILBOX),
      ensureDefaultCueSorting(MAILBOX),
      ensureDefaultCueSorting(MAILBOX),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(prisma.rule.createManyAndReturn).toHaveBeenCalledTimes(1);
    expect(afterCallbacks).toHaveLength(1);
  });

  describe("keeps an explicit choice", () => {
    it("leaves rules the person turned off alone", async () => {
      ruleRows = [
        { id: "off", systemType: SystemType.TO_REPLY, name: "To Reply" },
      ];

      expect(await ensureDefaultCueSorting(MAILBOX)).toBe(false);
      expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
      expect(afterCallbacks).toHaveLength(0);
    });

    it("leaves a mailbox whose rules were deleted alone", async () => {
      prisma.executedRule.findFirst.mockResolvedValue({ id: "run" } as never);

      expect(await ensureDefaultCueSorting(MAILBOX)).toBe(false);
      expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    });

    it("leaves a mailbox the person already chose for alone", async () => {
      markers.defaultSortingCheckedAt = new Date();

      expect(await ensureDefaultCueSorting(MAILBOX)).toBe(false);
      expect(prisma.rule.findFirst).not.toHaveBeenCalled();
      expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    });

    it("records the decision so the check never runs again", async () => {
      prisma.executedRule.findFirst.mockResolvedValue({ id: "run" } as never);

      await ensureDefaultCueSorting(MAILBOX);
      prisma.executedRule.findFirst.mockResolvedValue(null);
      await ensureDefaultCueSorting(MAILBOX);

      expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    });
  });

  // Picking a style without Cue's tabs used to add no rules; the same answer
  // now adds reply tracking, so that answer is no reason to leave it out.
  it("still adds the defaults when the style card was answered before it added rules", async () => {
    prisma.user.findUnique.mockResolvedValue({
      dismissedHints: [getInboxStyleHintId("account")],
    } as never);

    expect(await ensureDefaultCueSorting(MAILBOX)).toBe(true);
  });

  it("tries again at the next sync when setting up fails", async () => {
    prisma.rule.createManyAndReturn.mockRejectedValueOnce(new Error("db down"));

    await expect(ensureDefaultCueSorting(MAILBOX)).rejects.toThrow("db down");
    expect(markers).toEqual({
      defaultSortingCheckedAt: null,
      defaultSortingAppliedAt: null,
    });

    expect(await ensureDefaultCueSorting(MAILBOX)).toBe(true);
  });

  it("counts the defaults as added once the rules exist, even if sorting can't be scheduled", async () => {
    // setUpCueSorting reads the account after creating the rules.
    prisma.emailAccount.findUnique.mockRejectedValueOnce(new Error("db blip"));

    expect(await ensureDefaultCueSorting(MAILBOX)).toBe(true);
    expect(ruleRows).toHaveLength(REPLY_TRACKING_RULES.length);
    expect(markers.defaultSortingCheckedAt).toBeInstanceOf(Date);
    expect(markers.defaultSortingAppliedAt).toBeInstanceOf(Date);
  });
});

function createdRules() {
  return vi
    .mocked(prisma.rule.createManyAndReturn)
    .mock.calls.flatMap(([args]) => {
      const data = (args as { data: unknown }).data;
      return (Array.isArray(data) ? data : [data]) as Array<{
        emailAccountId: string;
        systemType: SystemType;
        enabled: boolean;
      }>;
    });
}

async function runAfterCallbacks() {
  for (const callback of afterCallbacks.splice(0)) await callback();
}
