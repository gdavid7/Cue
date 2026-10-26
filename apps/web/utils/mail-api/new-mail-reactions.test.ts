import type { SyncReadResult } from "@inboxzero/mail-core/ports/mailbox-source";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { getMockParsedMessage } from "@/__tests__/mocks/email-provider.mock";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import prisma from "@/utils/__mocks__/prisma";
import { notifyMailboxChanged } from "@/utils/mailbox-push";
import { claimNewMailReaction } from "@/utils/redis/new-mail-reaction";
import { wakeSnoozedThreadOnReply } from "@/utils/snooze/wake-on-reply";
import type { ParsedMessage } from "@/utils/types";
import { reactToSyncedNewMail } from "./new-mail-reactions";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/mailbox-push", () => ({ notifyMailboxChanged: vi.fn() }));
vi.mock("@/utils/redis/new-mail-reaction", () => ({
  claimNewMailReaction: vi.fn(),
  releaseNewMailReaction: vi.fn(),
}));
vi.mock("@/utils/snooze/wake-on-reply", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/snooze/wake-on-reply")>()),
  wakeSnoozedThreadOnReply: vi.fn(),
}));

const logger = createTestLogger();
const emailAccountId = "account-a";
const mutedAt = new Date(Date.now() - 60 * 60_000);
const arrivedAt = Date.now() - 5 * 60_000;

// An account provider pushes skip: no rules and no filing.
const unprocessedAccount = {
  id: emailAccountId,
  email: "me@example.com",
  userId: "user",
  filingEnabled: false,
  filingPrompt: null,
  rules: [],
  user: { aiApiKey: null, premium: null },
};

function arrival(overrides: Partial<ParsedMessage> = {}) {
  return getMockParsedMessage({
    id: "reply",
    threadId: "thread-a",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(arrivedAt),
    ...overrides,
    headers: {
      from: "Dana <dana@example.org>",
      to: "me@example.com",
      subject: "Re: plan",
      date: "",
      ...overrides.headers,
    },
  });
}

function syncPage(
  messages: { id: string; threadId: string; receivedAtMs?: number }[],
): SyncReadResult[] {
  return [
    {
      status: "page",
      page: {
        session: { accountId: emailAccountId, generation: "g" },
        requestId: "r",
        from: { streamId: "primary", generation: "g", checkpoint: null },
        to: { streamId: "primary", generation: "g", checkpoint: "c" },
        changes: messages.map((message) => ({
          kind: "message_patch" as const,
          key: { accountId: emailAccountId, messageId: message.id },
          reference: {
            provider: "google" as const,
            messageId: message.id,
            conversationId: message.threadId,
            version: "1",
          },
          fields: {
            roles: ["inbox" as const],
            receivedAtMs: message.receivedAtMs ?? arrivedAt,
          },
        })),
        requiredHydration: [],
        roundComplete: true,
      },
    },
  ] as SyncReadResult[];
}

async function react(
  message: ParsedMessage,
  results = syncPage([message]),
  providerName: "google" | "microsoft" = "google",
) {
  const provider = createMockEmailProvider({
    name: providerName,
    getMessage: vi.fn().mockResolvedValue(message),
    isSentMessage: vi.fn().mockReturnValue(false),
  });
  await reactToSyncedNewMail({ emailAccountId, provider, results, logger });
  return provider;
}

describe("reactToSyncedNewMail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mutedThread.findMany.mockResolvedValue([]);
    prisma.snoozedThread.findMany.mockResolvedValue([]);
    prisma.emailAccount.findUnique.mockResolvedValue(
      unprocessedAccount as never,
    );
    vi.mocked(claimNewMailReaction).mockResolvedValue(true);
    vi.mocked(wakeSnoozedThreadOnReply).mockResolvedValue(true);
  });

  describe.each([
    "google",
    "microsoft",
  ] as const)("a muted conversation (%s)", (providerName) => {
    beforeEach(() => {
      prisma.mutedThread.findMany.mockResolvedValue([
        { threadId: "thread-a", createdAt: mutedAt },
      ] as never);
      prisma.snoozedThread.findMany.mockResolvedValue([
        { threadId: "thread-a" },
      ] as never);
    });

    it("archives a new reply that synced into the inbox, and never wakes it", async () => {
      const provider = await react(arrival(), undefined, providerName);

      expect(provider.archiveMessage).toHaveBeenCalledExactlyOnceWith("reply");
      expect(provider.archiveThread).not.toHaveBeenCalled();
      expect(wakeSnoozedThreadOnReply).not.toHaveBeenCalled();
      expect(notifyMailboxChanged).toHaveBeenCalledOnce();
    });

    it("doesn't archive again when the webhook or another device already did", async () => {
      vi.mocked(claimNewMailReaction).mockResolvedValue(false);

      const provider = await react(arrival(), undefined, providerName);

      expect(provider.archiveMessage).not.toHaveBeenCalled();
      expect(notifyMailboxChanged).not.toHaveBeenCalled();
    });
  });

  it("leaves mail that was in the conversation before it was muted", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", createdAt: mutedAt },
    ] as never);
    const before = mutedAt.getTime() - 60_000;

    const provider = await react(
      arrival({ internalDate: String(before) }),
      syncPage([{ id: "reply", threadId: "thread-a", receivedAtMs: before }]),
    );

    expect(provider.getMessage).not.toHaveBeenCalled();
    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("leaves a muted conversation's message that is no longer in the inbox", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", createdAt: mutedAt },
    ] as never);

    const provider = await react(arrival({ labelIds: ["UNREAD"] }));

    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("wakes a snoozed conversation once for a page of replies", async () => {
    prisma.snoozedThread.findMany.mockResolvedValue([
      { threadId: "thread-a" },
    ] as never);
    const message = arrival();

    const provider = await react(
      message,
      syncPage([
        { id: "reply", threadId: "thread-a" },
        { id: "older", threadId: "thread-a", receivedAtMs: arrivedAt - 1000 },
      ]),
    );

    expect(wakeSnoozedThreadOnReply).toHaveBeenCalledExactlyOnceWith({
      emailAccount: expect.objectContaining({
        id: emailAccountId,
        email: "me@example.com",
        userId: "user",
      }),
      message,
      provider,
      logger,
    });
    expect(provider.archiveMessage).not.toHaveBeenCalled();
    expect(notifyMailboxChanged).toHaveBeenCalledOnce();
  });

  // Provider pushes run mute and the wake around the message's rules there.
  it("leaves accounts the provider pushes process to them", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", createdAt: mutedAt },
    ] as never);
    prisma.emailAccount.findUnique.mockResolvedValue({
      ...unprocessedAccount,
      rules: [{ id: "rule" }],
      user: {
        aiApiKey: null,
        premium: {
          tier: "PLUS_MONTHLY",
          stripeSubscriptionStatus: "active",
          lemonSqueezyRenewsAt: null,
          appleExpiresAt: null,
          appleRevokedAt: null,
          appleSubscriptionStatus: null,
          adminGrantExpiresAt: null,
          adminGrantTier: null,
        },
      },
    } as never);

    const provider = await react(arrival());

    expect(provider.archiveMessage).not.toHaveBeenCalled();
    expect(wakeSnoozedThreadOnReply).not.toHaveBeenCalled();
  });

  it("reads nothing more when no synced mail is in a muted or snoozed conversation", async () => {
    const provider = await react(arrival());

    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
    expect(provider.getMessage).not.toHaveBeenCalled();
  });

  it("ignores changes to older mail", async () => {
    const old = Date.now() - 3 * 24 * 60 * 60_000;

    await react(
      arrival(),
      syncPage([{ id: "reply", threadId: "thread-a", receivedAtMs: old }]),
    );

    expect(prisma.mutedThread.findMany).not.toHaveBeenCalled();
  });
});
