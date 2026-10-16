import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionType,
  MailSplitFilterKind,
  SystemType,
} from "@/generated/prisma/enums";
import { getRuleConfig, getRuleLabel } from "@/utils/rule/consts";
import prisma from "@/utils/__mocks__/prisma";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import { setUpCueSorting } from "@/utils/split-inbox/cue-tabs.server";
import {
  createMailSplit,
  updateMailSplit,
} from "@/utils/split-inbox/splits.server";

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/split-inbox/splits.server", () => ({
  createMailSplit: vi.fn(async () => ({ status: "created", id: "split" })),
  updateMailSplit: vi.fn(),
}));
vi.mock("@/utils/ai/choose-rule/bulk-process-emails", () => ({
  bulkProcessInboxEmails: vi.fn(),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: vi.fn(async () => ({ id: "account" })),
}));

const logger = createScopedLogger("cue-tabs-test");
const WITH_TABS = {
  emailAccountId: "account",
  provider: "google",
  addTabs: true,
  logger,
};
const WITHOUT_TABS = { ...WITH_TABS, addTabs: false };
const REPLY_TRACKING_RULES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
];
const NEEDED_RULES = [
  ...REPLY_TRACKING_RULES,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

describe("setUpCueSorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    prisma.rule.findMany.mockResolvedValue([]);
    // Most cases are accounts Cue has already sorted.
    prisma.executedRule.findFirst.mockResolvedValue({ id: "run" } as never);
    prisma.rule.createManyAndReturn.mockImplementation((async (args: {
      data: { systemType: SystemType }[];
    }) =>
      args.data.map((rule) => ({
        id: `new-${rule.systemType}`,
      }))) as never);
  });

  it("sorts mail inside Cue without touching the mailbox", async () => {
    await setUpCueSorting(WITH_TABS);

    const created = createdRules();
    expect(created.map((rule) => rule.systemType).sort()).toEqual(
      [...NEEDED_RULES].sort(),
    );
    for (const rule of created) {
      expect(rule.enabled).toBe(true);
      expect(rule).not.toHaveProperty("actions");
    }
    expect(createEmailProvider).not.toHaveBeenCalled();

    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split),
    ).toEqual([
      {
        emailAccountId: "account",
        name: "Needs reply",
        matchAll: true,
        filters: [
          { kind: MailSplitFilterKind.CUE, value: SystemType.TO_REPLY },
        ],
      },
      {
        emailAccountId: "account",
        name: "Reading",
        matchAll: false,
        filters: [
          { kind: MailSplitFilterKind.CUE, value: SystemType.NEWSLETTER },
          { kind: MailSplitFilterKind.CUE, value: SystemType.MARKETING },
        ],
      },
    ]);
    expect(afterCallbacks).toHaveLength(1);
  });

  it("keeps rules the account already has and still adds the tabs", async () => {
    prisma.rule.findMany.mockResolvedValue(
      NEEDED_RULES.map((systemType) => existingRule(systemType)) as never,
    );

    await setUpCueSorting(WITH_TABS);

    expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split.name),
    ).toEqual(["Needs reply", "Reading"]);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("stops the rules it used to create from labelling the mailbox", async () => {
    prisma.rule.findMany.mockResolvedValue(legacyLabelledRules() as never);

    await setUpCueSorting(WITH_TABS);

    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            `label-${SystemType.TO_REPLY}`,
            `label-${SystemType.AWAITING_REPLY}`,
            `label-${SystemType.ACTIONED}`,
            `label-${SystemType.NEWSLETTER}`,
          ],
        },
      },
    });
    expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
    expect(prisma.rule.updateMany).not.toHaveBeenCalled();
  });

  it("keeps the mailbox's label actions when the person only picks a style", async () => {
    prisma.rule.findMany.mockResolvedValue(legacyLabelledRules() as never);

    await setUpCueSorting(WITHOUT_TABS);

    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
  });

  it("points an earlier label-backed tab of the same name at Cue's sorting", async () => {
    vi.mocked(createMailSplit).mockResolvedValue({
      status: "duplicate",
    } as never);
    prisma.mailSplit.findFirst
      .mockResolvedValueOnce({
        id: "old-needs-reply",
        filters: [{ kind: MailSplitFilterKind.LABEL }],
      } as never)
      .mockResolvedValueOnce({
        id: "custom-reading",
        filters: [{ kind: MailSplitFilterKind.FROM }],
      } as never);

    await setUpCueSorting(WITH_TABS);

    expect(vi.mocked(updateMailSplit).mock.calls).toEqual([
      [
        {
          emailAccountId: "account",
          id: "old-needs-reply",
          name: "Needs reply",
          matchAll: true,
          filters: [
            { kind: MailSplitFilterKind.CUE, value: SystemType.TO_REPLY },
          ],
        },
      ],
    ]);
  });

  it("adds missing reply tracking rules without tabs when the person skips them", async () => {
    await setUpCueSorting(WITHOUT_TABS);

    const created = createdRules();
    expect(created.map((rule) => rule.systemType).sort()).toEqual(
      [...REPLY_TRACKING_RULES].sort(),
    );
    for (const rule of created) expect(rule.enabled).toBe(true);
    expect(createMailSplit).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it("leaves a reply tracking rule the person turned off alone", async () => {
    prisma.rule.findMany.mockResolvedValue(
      REPLY_TRACKING_RULES.map((systemType) =>
        systemType === SystemType.TO_REPLY
          ? {
              ...existingRule(systemType),
              enabled: false,
              actions: [
                { id: "draft", type: ActionType.DRAFT_EMAIL, label: null },
              ],
            }
          : existingRule(systemType),
      ) as never,
    );

    await setUpCueSorting(WITHOUT_TABS);

    expect(prisma.rule.update).not.toHaveBeenCalled();
    expect(prisma.rule.updateMany).not.toHaveBeenCalled();
    expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(0);
  });

  it("sorts the inbox with only the rules it just created", async () => {
    prisma.rule.findMany.mockResolvedValue([
      { ...existingRule(SystemType.TO_REPLY), enabled: false },
    ] as never);

    await setUpCueSorting(WITHOUT_TABS);
    for (const callback of afterCallbacks) await callback();

    expect(bulkProcessInboxEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleIds: [
          `new-${SystemType.AWAITING_REPLY}`,
          `new-${SystemType.FYI}`,
          `new-${SystemType.ACTIONED}`,
        ],
      }),
    );
  });

  it("sorts a never-sorted mailbox with the reply tracking rules it started with", async () => {
    prisma.executedRule.findFirst.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue(
      REPLY_TRACKING_RULES.map((systemType) =>
        existingRule(systemType),
      ) as never,
    );

    await setUpCueSorting(WITHOUT_TABS);
    for (const callback of afterCallbacks) await callback();

    expect(prisma.rule.createManyAndReturn).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    expect(bulkProcessInboxEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleIds: REPLY_TRACKING_RULES.map((systemType) => `rule-${systemType}`),
      }),
    );
  });

  it("doesn't sort again a mailbox Cue has already sorted", async () => {
    prisma.rule.findMany.mockResolvedValue(
      REPLY_TRACKING_RULES.map((systemType) =>
        existingRule(systemType),
      ) as never,
    );

    await setUpCueSorting(WITHOUT_TABS);

    expect(afterCallbacks).toHaveLength(0);
  });

  it("leaves disabled rules and rules with actions out of a first sort", async () => {
    prisma.executedRule.findFirst.mockResolvedValue(null);
    prisma.rule.findMany.mockResolvedValue(
      REPLY_TRACKING_RULES.map((systemType) => {
        if (systemType === SystemType.TO_REPLY)
          return { ...existingRule(systemType), enabled: false };
        if (systemType === SystemType.FYI)
          return {
            ...existingRule(systemType),
            actions: [{ id: "archive", type: ActionType.ARCHIVE, label: null }],
          };
        return existingRule(systemType);
      }) as never,
    );

    await setUpCueSorting(WITHOUT_TABS);
    for (const callback of afterCallbacks) await callback();

    expect(bulkProcessInboxEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        ruleIds: [
          `rule-${SystemType.AWAITING_REPLY}`,
          `rule-${SystemType.ACTIONED}`,
        ],
      }),
    );
  });

  it("skips a rule whose name the person already uses for their own rule", async () => {
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "my-fyi",
        name: getRuleConfig(SystemType.FYI).name,
        systemType: null,
        actions: [{ id: "my-archive", type: ActionType.ARCHIVE, label: null }],
      },
    ] as never);

    await setUpCueSorting(WITH_TABS);

    expect(createdRules().map((rule) => rule.systemType)).not.toContain(
      SystemType.FYI,
    );
    expect(prisma.rule.createManyAndReturn).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );
    expect(prisma.rule.update).not.toHaveBeenCalled();
    expect(prisma.rule.upsert).not.toHaveBeenCalled();
    expect(prisma.rule.delete).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
  });

  it("explains the split limit instead of failing silently", async () => {
    vi.mocked(createMailSplit).mockResolvedValueOnce({
      status: "limit",
    } as never);

    await expect(setUpCueSorting(WITH_TABS)).rejects.toThrow(
      "You can only have",
    );
  });
});

function createdRules() {
  return (prisma.rule.createManyAndReturn.mock.calls[0]?.[0]?.data ??
    []) as Array<{
    systemType: SystemType;
    enabled: boolean;
    emailAccountId: string;
  }>;
}

function existingRule(systemType: SystemType) {
  return {
    id: `rule-${systemType}`,
    name: getRuleConfig(systemType).name,
    systemType,
    enabled: true,
    actions: [],
  };
}

function legacyLabelledRules() {
  return NEEDED_RULES.map((systemType) => ({
    ...existingRule(systemType),
    actions:
      systemType === SystemType.FYI
        ? [
            { id: "fyi-label", type: ActionType.LABEL, label: "FYI" },
            { id: "fyi-archive", type: ActionType.ARCHIVE, label: null },
          ]
        : [
            {
              id: `label-${systemType}`,
              type: ActionType.LABEL,
              label:
                systemType === SystemType.MARKETING
                  ? "My promos"
                  : getRuleLabel(systemType).toLowerCase(),
            },
          ],
  }));
}
