import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { ConditionType } from "@/utils/config";

const { createEmailProviderMock, createRuleHistoryMock, setRuleEnabledMock } =
  vi.hoisted(() => ({
    createEmailProviderMock: vi.fn(),
    createRuleHistoryMock: vi.fn(),
    setRuleEnabledMock: vi.fn(),
  }));

vi.mock("@/utils/rule/rule", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/utils/rule/rule")>();
  return {
    ...actual,
    setRuleEnabled: setRuleEnabledMock,
  };
});

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/rule/rule-history", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/rule/rule-history")>()),
  createRuleHistory: createRuleHistoryMock,
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: () => unknown) => task(),
}));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@example.com" } })),
}));

import prisma from "@/utils/__mocks__/prisma";
import { Prisma } from "@/generated/prisma/client";
import { createEmailProvider } from "@/utils/email/provider";
import {
  deleteRuleAction,
  enableDraftRepliesAction,
  toggleRuleAction,
  updateRuleAction,
} from "@/utils/actions/rule";
import { RULE_MANAGED_BY_ORGANIZATION_ERROR } from "@/utils/organizations/rules";

describe("enableDraftRepliesAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
  });

  it("re-enables the existing to-reply rule before adding draft actions", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      enabled: false,
      systemType: SystemType.TO_REPLY,
      actions: [],
    } as never);

    setRuleEnabledMock.mockResolvedValue({
      id: "rule-1",
      enabled: true,
      actions: [],
    });

    await enableDraftRepliesAction("ea_1" as never, { enable: true } as never);

    expect(setRuleEnabledMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      emailAccountId: "ea_1",
      enabled: true,
    });
    expect(prisma.action.create).toHaveBeenCalledWith({
      data: {
        emailAccountId: "ea_1",
        messagingChannelEmailAccountId: null,
        ruleId: "rule-1",
        type: ActionType.DRAFT_EMAIL,
      },
    });
  });

  // The founder's call: turning drafts on must not touch Gmail. A mailbox
  // without To Reply gets a draft-only rule, as new mailboxes do.
  it("creates a draft-only to-reply rule without creating a Gmail label", async () => {
    mockAccount();
    prisma.rule.findUnique.mockResolvedValue(null);
    prisma.rule.create.mockResolvedValue({
      id: "rule-new",
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);

    const result = await enableDraftRepliesAction(
      "ea_1" as never,
      { enable: true } as never,
    );

    expect(result?.serverError).toBeUndefined();
    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(prisma.rule.create).toHaveBeenCalledTimes(1);
    const { data } = prisma.rule.create.mock.calls[0][0];
    expect(data).toMatchObject({
      emailAccountId: "ea_1",
      systemType: SystemType.TO_REPLY,
      enabled: true,
      actions: { create: [{ type: ActionType.DRAFT_EMAIL }] },
    });
    expect(prisma.action.create).not.toHaveBeenCalled();
    expect(createRuleHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ triggerType: "created" }),
    );
  });

  // DR-5: no To Reply rule reads as on, so off has to be saved as a To Reply
  // rule that is turned off, or the toggle would snap back on.
  it("saves off for a mailbox without To Reply as a disabled rule", async () => {
    mockAccount();
    prisma.rule.findUnique.mockResolvedValue(null);
    prisma.rule.create.mockResolvedValue({ id: "rule-new" } as never);

    await enableDraftRepliesAction("ea_1" as never, { enable: false } as never);

    const { data } = prisma.rule.create.mock.calls[0][0];
    expect(data).toMatchObject({
      emailAccountId: "ea_1",
      systemType: SystemType.TO_REPLY,
      enabled: false,
    });
    expect(data).not.toHaveProperty("actions");
    expect(prisma.action.create).not.toHaveBeenCalled();
  });

  it("reports a rule of the user's own that already has the To Reply name", async () => {
    mockAccount();
    prisma.rule.findUnique.mockResolvedValue(null);
    prisma.rule.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["name", "emailAccountId"] },
      }),
    );

    const result = await enableDraftRepliesAction(
      "ea_1" as never,
      { enable: true } as never,
    );

    expect(result?.serverError).toBe(
      'You already have a rule named "To Reply". Rename it and try again.',
    );
    expect(prisma.action.create).not.toHaveBeenCalled();
  });

  // Older mailboxes' To Reply labels; turning drafts on leaves that alone.
  it("keeps an enabled to-reply rule's label and only adds the draft", async () => {
    mockAccount();
    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      enabled: true,
      systemType: SystemType.TO_REPLY,
      actions: [{ id: "label-1", type: ActionType.LABEL }],
    } as never);

    await enableDraftRepliesAction("ea_1" as never, { enable: true } as never);

    expect(createEmailProvider).not.toHaveBeenCalled();
    expect(setRuleEnabledMock).not.toHaveBeenCalled();
    expect(prisma.rule.create).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
    expect(prisma.action.create).toHaveBeenCalledTimes(1);
    expect(prisma.action.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        ruleId: "rule-1",
        type: ActionType.DRAFT_EMAIL,
      }),
    });
  });

  it("disables the existing to-reply rule when draft replies are turned off", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      enabled: true,
      systemType: SystemType.TO_REPLY,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);

    setRuleEnabledMock.mockResolvedValue({
      id: "rule-1",
      enabled: false,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    });

    await enableDraftRepliesAction("ea_1" as never, { enable: false } as never);

    expect(setRuleEnabledMock).toHaveBeenCalledWith({
      ruleId: "rule-1",
      emailAccountId: "ea_1",
      enabled: false,
    });
    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: {
        ruleId: "rule-1",
        type: ActionType.DRAFT_EMAIL,
      },
    });
  });
});

function mockAccount() {
  (
    prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
  ).mockResolvedValue({
    email: "owner@example.com",
    account: { userId: "u1", provider: "google" },
  });
}

describe("deleteRuleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
  });

  it("rejects deleting default rules", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      id: "rule-1",
      emailAccountId: "ea_1",
      systemType: SystemType.NEWSLETTER,
      groupId: null,
    } as never);

    const result = await deleteRuleAction(
      "ea_1" as never,
      {
        id: "rule-1",
      } as never,
    );

    expect(result?.serverError).toBe(
      "Default rules cannot be deleted. Disable them instead.",
    );
    expect(prisma.rule.delete).not.toHaveBeenCalled();
    expect(prisma.group.deleteMany).not.toHaveBeenCalled();
  });
});

describe("updateRuleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
    prisma.rule.findMany.mockResolvedValue([]);
  });

  it("scopes the rule update to the bound email account", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.update.mockResolvedValue({
      id: "victim-rule",
      actions: [],
      group: null,
    } as never);

    const result = await updateRuleAction(
      "attacker-account" as never,
      {
        id: "victim-rule",
        name: "Updated rule",
        instructions: null,
        groupId: null,
        runOnThreads: true,
        digest: false,
        actions: [
          {
            type: ActionType.ARCHIVE,
            messagingChannelId: null,
            labelId: null,
            subject: null,
            content: null,
            to: null,
            cc: null,
            bcc: null,
            url: null,
            folderName: null,
            folderId: null,
            delayInMinutes: null,
          },
        ],
        conditions: [
          {
            type: ConditionType.STATIC,
            instructions: null,
            to: null,
            from: "sender@example.com",
            subject: null,
            body: null,
          },
        ],
        conditionalOperator: "AND",
        systemType: null,
      } as never,
    );

    expect(result?.serverError).toBeUndefined();
    expect(prisma.rule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: "victim-rule",
          emailAccountId: "attacker-account",
        },
      }),
    );
  });

  it("rejects updating an org-managed rule copy", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      organizationRuleId: "org-rule-1",
    } as never);

    const result = await updateRuleAction(
      "ea_1" as never,
      {
        id: "managed-rule",
        name: "Updated rule",
        instructions: null,
        groupId: null,
        runOnThreads: true,
        digest: false,
        actions: [
          {
            type: ActionType.ARCHIVE,
            messagingChannelId: null,
            labelId: null,
            subject: null,
            content: null,
            to: null,
            cc: null,
            bcc: null,
            url: null,
            folderName: null,
            folderId: null,
            delayInMinutes: null,
          },
        ],
        conditions: [
          {
            type: ConditionType.STATIC,
            instructions: null,
            to: null,
            from: "sender@example.com",
            subject: null,
            body: null,
          },
        ],
        conditionalOperator: "AND",
        systemType: null,
      } as never,
    );

    expect(result?.serverError).toBe(RULE_MANAGED_BY_ORGANIZATION_ERROR);
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });
});

describe("toggleRuleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createEmailProvider).mockResolvedValue({} as any);
  });

  it("rejects toggling an org-managed rule copy via the personal path", async () => {
    (
      prisma.emailAccount.findUnique as ReturnType<typeof vi.fn>
    ).mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "u1", provider: "google" },
    });

    prisma.rule.findUnique.mockResolvedValue({
      organizationRuleId: "org-rule-1",
    } as never);

    const result = await toggleRuleAction(
      "ea_1" as never,
      { ruleId: "managed-rule", enabled: true } as never,
    );

    expect(result?.serverError).toBe(RULE_MANAGED_BY_ORGANIZATION_ERROR);
    expect(setRuleEnabledMock).not.toHaveBeenCalled();
  });
});
