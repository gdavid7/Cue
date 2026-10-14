import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ActionType,
  MailSplitFilterKind,
  SystemType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { getRuleLabel } from "@/utils/rule/consts";
import { upsertSystemRule } from "@/utils/rule/rule";
import { addCueTabs } from "@/utils/split-inbox/cue-tabs.server";
import { createMailSplit } from "@/utils/split-inbox/splits.server";

const { afterCallbacks, emailProvider } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
  emailProvider: { getLabels: vi.fn(), createLabel: vi.fn() },
}));

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => emailProvider),
}));
vi.mock("@/utils/rule/rule", () => ({ upsertSystemRule: vi.fn() }));
vi.mock("@/utils/split-inbox/splits.server", () => ({
  createMailSplit: vi.fn(async () => ({ status: "created", id: "split" })),
}));
vi.mock("@/utils/ai/choose-rule/bulk-process-emails", () => ({
  bulkProcessInboxEmails: vi.fn(),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: vi.fn(async () => ({ id: "account" })),
}));

const logger = createScopedLogger("cue-tabs-test");
const NEEDED_RULES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

describe("addCueTabs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
    prisma.rule.findMany.mockResolvedValue([]);
    emailProvider.getLabels.mockResolvedValue([]);
    emailProvider.createLabel.mockImplementation(async (name: string) => ({
      id: `label-${name}`,
      name,
      type: "user",
    }));
  });

  it("creates only the label rules and the two tabs that Needs reply and Reading read", async () => {
    await addCueTabs({ emailAccountId: "account", provider: "google", logger });

    const upserts = vi
      .mocked(upsertSystemRule)
      .mock.calls.map(([rule]) => rule);
    expect(upserts.map((rule) => rule.systemType).sort()).toEqual(
      [...NEEDED_RULES].sort(),
    );
    // Labels only: nothing that archives, moves or drafts.
    for (const rule of upserts) {
      expect(rule.enabled).toBe(true);
      expect(rule.actions).toEqual([
        {
          type: ActionType.LABEL,
          label: getRuleLabel(rule.systemType),
          labelId: `label-${getRuleLabel(rule.systemType)}`,
        },
      ]);
    }

    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split),
    ).toEqual([
      {
        emailAccountId: "account",
        name: "Needs reply",
        matchAll: true,
        filters: [{ kind: MailSplitFilterKind.LABEL, value: "label-To Reply" }],
      },
      {
        emailAccountId: "account",
        name: "Reading",
        matchAll: false,
        filters: [
          { kind: MailSplitFilterKind.LABEL, value: "label-Newsletter" },
          { kind: MailSplitFilterKind.LABEL, value: "label-Marketing" },
        ],
      },
    ]);
    expect(afterCallbacks).toHaveLength(1);
  });

  it("lists labels once, reuses the ones that exist and creates the rest", async () => {
    emailProvider.getLabels.mockResolvedValue([
      { id: "existing-newsletter", name: "newsletter", type: "user" },
    ]);

    await addCueTabs({ emailAccountId: "account", provider: "google", logger });

    expect(emailProvider.getLabels).toHaveBeenCalledTimes(1);
    expect(
      emailProvider.createLabel.mock.calls.map(([name]) => name).sort(),
    ).toEqual(
      NEEDED_RULES.filter((type) => type !== SystemType.NEWSLETTER)
        .map((type) => getRuleLabel(type))
        .sort(),
    );
    const newsletterRule = vi
      .mocked(upsertSystemRule)
      .mock.calls.find(([rule]) => rule.systemType === SystemType.NEWSLETTER);
    expect(newsletterRule?.[0].actions).toEqual([
      {
        type: ActionType.LABEL,
        label: getRuleLabel(SystemType.NEWSLETTER),
        labelId: "existing-newsletter",
      },
    ]);
  });

  it("still adds the rule, without a label id, when its label can't be created", async () => {
    emailProvider.createLabel.mockImplementation(async (name: string) => {
      if (name === getRuleLabel(SystemType.MARKETING))
        throw new Error("create failed");
      return { id: `label-${name}`, name, type: "user" };
    });

    await addCueTabs({ emailAccountId: "account", provider: "google", logger });

    const marketingRule = vi
      .mocked(upsertSystemRule)
      .mock.calls.find(([rule]) => rule.systemType === SystemType.MARKETING);
    expect(marketingRule?.[0].actions).toEqual([
      {
        type: ActionType.LABEL,
        label: getRuleLabel(SystemType.MARKETING),
        labelId: null,
      },
    ]);
    expect(vi.mocked(createMailSplit).mock.calls.at(-1)?.[0].filters).toEqual([
      { kind: MailSplitFilterKind.LABEL, value: "label-Newsletter" },
    ]);
  });

  it("keeps rules the account already has and points the tabs at their labels", async () => {
    prisma.rule.findMany.mockResolvedValue(
      NEEDED_RULES.map((systemType) => ({
        systemType,
        actions: [
          { type: ActionType.DRAFT_EMAIL, labelId: null },
          { type: ActionType.LABEL, labelId: `existing-${systemType}` },
        ],
      })) as never,
    );

    await addCueTabs({ emailAccountId: "account", provider: "google", logger });

    expect(upsertSystemRule).not.toHaveBeenCalled();
    expect(
      vi.mocked(createMailSplit).mock.calls.map(([split]) => split.filters),
    ).toEqual([
      [{ kind: MailSplitFilterKind.LABEL, value: "existing-TO_REPLY" }],
      [
        { kind: MailSplitFilterKind.LABEL, value: "existing-NEWSLETTER" },
        { kind: MailSplitFilterKind.LABEL, value: "existing-MARKETING" },
      ],
    ]);
    expect(afterCallbacks).toHaveLength(0);
  });

  it("explains the split limit instead of failing silently", async () => {
    vi.mocked(createMailSplit).mockResolvedValueOnce({
      status: "limit",
    } as never);

    await expect(
      addCueTabs({ emailAccountId: "account", provider: "google", logger }),
    ).rejects.toThrow("You can only have");
  });
});
