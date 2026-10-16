import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionType,
  MailSplitFilterKind,
  SystemType,
} from "@/generated/prisma/enums";
import { getRuleLabel } from "@/utils/rule/consts";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import { upsertSystemRule } from "@/utils/rule/rule";
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
vi.mock("@/utils/rule/rule", () => ({ upsertSystemRule: vi.fn() }));
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
const REPLY_TRACKING_RULES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
];
const NEEDED_RULES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

describe("setUpCueSorting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    prisma.rule.findMany.mockResolvedValue([]);
  });

  it("sorts mail inside Cue without touching the mailbox", async () => {
    await setUpCueSorting(WITH_TABS);

    const upserts = vi
      .mocked(upsertSystemRule)
      .mock.calls.map(([rule]) => rule);
    expect(upserts.map((rule) => rule.systemType).sort()).toEqual(
      [...NEEDED_RULES].sort(),
    );
    for (const rule of upserts) {
      expect(rule.enabled).toBe(true);
      expect(rule.actions).toEqual([]);
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
      NEEDED_RULES.map((systemType) => ({
        id: `rule-${systemType}`,
        systemType,
        enabled: true,
        actions: [],
      })) as never,
    );

    await setUpCueSorting(WITH_TABS);

    expect(upsertSystemRule).not.toHaveBeenCalled();
    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split.name),
    ).toEqual(["Needs reply", "Reading"]);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("stops the rules it used to create from labelling the mailbox", async () => {
    prisma.rule.findMany.mockResolvedValue(
      NEEDED_RULES.map((systemType) => ({
        id: `rule-${systemType}`,
        systemType,
        enabled: true,
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
      })) as never,
    );

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
    expect(upsertSystemRule).not.toHaveBeenCalled();
    expect(prisma.rule.update).not.toHaveBeenCalled();
    expect(prisma.rule.updateMany).not.toHaveBeenCalled();
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

  it("turns reply tracking on without adding tabs when the person skips them", async () => {
    await setUpCueSorting({ ...WITH_TABS, addTabs: false });

    const upserts = vi
      .mocked(upsertSystemRule)
      .mock.calls.map(([rule]) => rule);
    expect(upserts.map((rule) => rule.systemType).sort()).toEqual(
      [...REPLY_TRACKING_RULES].sort(),
    );
    for (const rule of upserts) {
      expect(rule.enabled).toBe(true);
      expect(rule.actions).toEqual([]);
    }
    expect(createMailSplit).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
  });

  it("turns reply tracking rules back on when the account has them off", async () => {
    prisma.rule.findMany.mockResolvedValue(
      REPLY_TRACKING_RULES.map((systemType) => ({
        id: `rule-${systemType}`,
        systemType,
        enabled: systemType !== SystemType.TO_REPLY,
        actions: [],
      })) as never,
    );
    prisma.rule.updateMany.mockResolvedValue({ count: 1 });

    await setUpCueSorting({ ...WITH_TABS, addTabs: false });

    expect(upsertSystemRule).not.toHaveBeenCalled();
    expect(prisma.rule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [`rule-${SystemType.TO_REPLY}`] } },
      data: { enabled: true },
    });
    expect(afterCallbacks).toHaveLength(1);
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
