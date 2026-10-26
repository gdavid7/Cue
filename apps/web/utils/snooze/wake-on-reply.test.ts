import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { getMockParsedMessage } from "@/__tests__/mocks/email-provider.mock";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import prisma from "@/utils/__mocks__/prisma";
import { createEmailProvider } from "@/utils/email/provider";
import { unsnoozeThreads } from "@/utils/snooze/unsnooze";
import type { ParsedMessage } from "@/utils/types";
import { wakeSnoozedThreadOnReply } from "./wake-on-reply";

vi.mock("@/utils/prisma");
vi.mock("@/utils/snooze/unsnooze", () => ({ unsnoozeThreads: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));

const logger = createTestLogger();
const emailAccount = {
  id: "account-a",
  email: "me@example.com",
  userId: "user",
};
const snoozedAt = new Date("2026-10-20T09:00:00.000Z");
const answeredAt = String(snoozedAt.getTime() + 60_000);

function reply(overrides: Partial<ParsedMessage> = {}) {
  return getMockParsedMessage({
    id: "reply",
    threadId: "thread-a",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: answeredAt,
    ...overrides,
    headers: {
      from: "Dana <dana@example.org>",
      to: emailAccount.email,
      subject: "Re: plan",
      date: "",
      "in-reply-to": "<original@example.org>",
      references: "<original@example.org>",
      ...overrides.headers,
    },
  });
}

async function wake(
  message: ParsedMessage,
  providerName: "google" | "microsoft" = "google",
) {
  const provider = createMockEmailProvider({
    name: providerName,
    getMessage: vi.fn().mockResolvedValue(message),
    getSignatures: vi.fn().mockResolvedValue([
      { email: "me@example.com", signature: "", isDefault: true },
      { email: "alias@example.net", signature: "", isDefault: false },
    ]),
  });
  await wakeSnoozedThreadOnReply({ emailAccount, message, provider, logger });
  return provider;
}

describe("wakeSnoozedThreadOnReply", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.snoozedThread.findFirst.mockResolvedValue({
      updatedAt: snoozedAt,
    } as never);
    prisma.snoozedThread.findMany.mockResolvedValue([]);
    prisma.emailAccount.findMany.mockResolvedValue([
      { email: "me@example.com" },
      { email: "Me.Work@example.com" },
    ] as never);
    prisma.mutedThread.findUnique.mockResolvedValue(null);
    vi.mocked(unsnoozeThreads).mockResolvedValue({
      unsnoozedThreadIds: ["thread-a"],
    });
  });

  it.each([
    "google",
    "microsoft",
  ] as const)("wakes the conversation when someone else replies (%s)", async (name) => {
    const provider = await wake(reply(), name);

    expect(prisma.snoozedThread.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account-a",
          threadId: "thread-a",
          status: SnoozedThreadStatus.PENDING,
        },
      }),
    );
    expect(unsnoozeThreads).toHaveBeenCalledExactlyOnceWith({
      emailAccountId: "account-a",
      logger,
      provider,
      threadIds: ["thread-a"],
    });
  });

  it("leaves a conversation without a pending snooze alone", async () => {
    prisma.snoozedThread.findFirst.mockResolvedValue(null);

    const provider = await wake(reply());

    expect(provider.getMessage).not.toHaveBeenCalled();
    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it("doesn't wake for the user's own mail from another connected account", async () => {
    await wake(reply({ headers: { from: "me.work@example.com" } as never }));

    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it("doesn't wake for the user's own Gmail send-as alias", async () => {
    const provider = await wake(
      reply({ headers: { from: "Me <ALIAS@example.net>" } as never }),
    );

    expect(provider.getSignatures).toHaveBeenCalled();
    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it("doesn't wake when Gmail's alias list can't be read", async () => {
    const message = reply();
    const provider = createMockEmailProvider({
      getMessage: vi.fn().mockResolvedValue(message),
      getSignatures: vi.fn().mockRejectedValue(new Error("offline")),
    });

    await wakeSnoozedThreadOnReply({ emailAccount, message, provider, logger });

    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it.each([
    ["a sent message", ["SENT"]],
    ["a draft", ["DRAFT"]],
    ["spam", ["SPAM"]],
    ["trash", ["TRASH"]],
    ["mail a rule archived", ["UNREAD"]],
  ])("doesn't wake for %s", async (_, labelIds) => {
    await wake(reply({ labelIds }));

    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it("judges the message as it is now, after its rules ran", async () => {
    const arrival = reply();
    const provider = createMockEmailProvider({
      getMessage: vi.fn().mockResolvedValue(reply({ labelIds: ["SPAM"] })),
      getSignatures: vi.fn().mockResolvedValue([]),
    });

    await wakeSnoozedThreadOnReply({
      emailAccount,
      message: arrival,
      provider,
      logger,
    });

    expect(provider.getMessage).toHaveBeenCalledWith("reply");
    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  it("doesn't wake for mail that was already there when it was snoozed", async () => {
    await wake(reply({ internalDate: String(snoozedAt.getTime() - 1000) }));

    expect(unsnoozeThreads).not.toHaveBeenCalled();
  });

  describe("copies in the user's other accounts", () => {
    const copyProvider = createMockEmailProvider({
      name: "microsoft",
      getMessageByRfc822MessageId: vi
        .fn()
        .mockResolvedValue(
          getMockParsedMessage({ id: "copy", threadId: "thread-b" }),
        ),
    });

    beforeEach(() => {
      vi.mocked(createEmailProvider).mockResolvedValue(copyProvider);
      prisma.snoozedThread.findMany.mockResolvedValue([
        {
          threadId: "thread-b",
          updatedAt: snoozedAt,
          emailAccountId: "account-b",
          emailAccount: { account: { provider: "microsoft" } },
        },
      ] as never);
    });

    it("wakes the snoozed copy of the conversation in another account", async () => {
      await wake(reply());

      expect(prisma.snoozedThread.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            status: SnoozedThreadStatus.PENDING,
            emailAccountId: { not: "account-a" },
            emailAccount: { userId: "user" },
          },
        }),
      );
      expect(copyProvider.getMessageByRfc822MessageId).toHaveBeenCalledWith(
        "original@example.org",
      );
      expect(unsnoozeThreads).toHaveBeenLastCalledWith({
        emailAccountId: "account-b",
        logger,
        provider: copyProvider,
        threadIds: ["thread-b"],
      });
    });

    it("leaves a muted copy snoozed", async () => {
      prisma.mutedThread.findUnique.mockResolvedValue({ id: "mute" } as never);

      await wake(reply());

      expect(unsnoozeThreads).toHaveBeenCalledOnce();
    });

    it("doesn't look for copies when this account's conversation didn't wake", async () => {
      vi.mocked(unsnoozeThreads).mockResolvedValue({ unsnoozedThreadIds: [] });

      await wake(reply());

      expect(prisma.snoozedThread.findMany).not.toHaveBeenCalled();
    });
  });
});
