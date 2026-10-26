import type { ProviderChange } from "@inboxzero/mail-core/sync";
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
): ProviderChange[] {
  return messages.map((message) => ({
    kind: "message_patch",
    key: { accountId: emailAccountId, messageId: message.id },
    reference: {
      provider: "google",
      messageId: message.id,
      conversationId: message.threadId,
      version: "1",
    },
    fields: {
      roles: ["inbox"],
      receivedAtMs: message.receivedAtMs ?? arrivedAt,
    },
  }));
}

async function react(
  message: ParsedMessage,
  changes = syncPage([message]),
  providerName: "google" | "microsoft" = "google",
) {
  const provider = createMockEmailProvider({
    name: providerName,
    getMessage: vi.fn().mockResolvedValue(message),
    isSentMessage: vi.fn().mockReturnValue(false),
  });
  await reactToSyncedNewMail({ emailAccountId, provider, changes, logger });
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
    vi.mocked(claimNewMailReaction).mockResolvedValue("claimed");
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
        { threadId: "thread-a", updatedAt: mutedAt },
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
      vi.mocked(claimNewMailReaction).mockResolvedValue("taken");

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

  // Sync runs on every device, so without Redis to say who moved first it
  // leaves the move to the webhook or the snooze's own time.
  it("moves nothing when Redis can't say whether another path already did", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", createdAt: mutedAt },
    ] as never);
    vi.mocked(claimNewMailReaction).mockResolvedValue("unavailable");

    const provider = await react(arrival());

    expect(provider.archiveMessage).not.toHaveBeenCalled();
  });

  it("skips the read for Cue's own archive syncing back", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", createdAt: mutedAt },
    ] as never);
    const [change] = syncPage([{ id: "reply", threadId: "thread-a" }]);
    if (change.kind !== "message_patch") throw new Error("not a patch");

    const provider = await react(arrival(), [
      { ...change, fields: { ...change.fields, roles: [] } },
    ]);

    expect(prisma.mutedThread.findMany).not.toHaveBeenCalled();
    expect(provider.getMessage).not.toHaveBeenCalled();
  });

  // The client's cursor has moved on, so mail past the cap is never seen
  // again: the cap counts only mail in muted or snoozed conversations.
  it("reaches a muted reply behind a page of other new mail", async () => {
    prisma.mutedThread.findMany.mockResolvedValue([
      { threadId: "thread-muted", createdAt: mutedAt },
    ] as never);
    const others = Array.from({ length: 30 }, (_, index) => ({
      id: `other-${index}`,
      threadId: `thread-${index}`,
      receivedAtMs: arrivedAt + 1000 + index,
    }));
    const muted = arrival({ id: "muted-reply", threadId: "thread-muted" });

    const provider = await react(
      muted,
      syncPage([
        ...others,
        {
          id: "muted-reply",
          threadId: "thread-muted",
          receivedAtMs: arrivedAt,
        },
      ]),
    );

    expect(provider.getMessage).toHaveBeenCalledExactlyOnceWith("muted-reply");
    expect(provider.archiveMessage).toHaveBeenCalledExactlyOnceWith(
      "muted-reply",
    );
  });

  it("doesn't read mail that was already there when it was snoozed", async () => {
    prisma.snoozedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", updatedAt: new Date(arrivedAt + 1000) },
    ] as never);

    const provider = await react(arrival());

    expect(provider.getMessage).not.toHaveBeenCalled();
    expect(wakeSnoozedThreadOnReply).not.toHaveBeenCalled();
  });

  it("tries an older reply on the page when the newest doesn't wake it", async () => {
    prisma.snoozedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", updatedAt: mutedAt },
    ] as never);
    vi.mocked(wakeSnoozedThreadOnReply)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await react(
      arrival(),
      syncPage([
        { id: "reply", threadId: "thread-a" },
        { id: "older", threadId: "thread-a", receivedAtMs: arrivedAt - 1000 },
        { id: "oldest", threadId: "thread-a", receivedAtMs: arrivedAt - 2000 },
      ]),
    );

    expect(wakeSnoozedThreadOnReply).toHaveBeenCalledTimes(2);
  });

  it("wakes a snoozed conversation once for a page of replies", async () => {
    prisma.snoozedThread.findMany.mockResolvedValue([
      { threadId: "thread-a", updatedAt: mutedAt },
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
      messageIsCurrent: true,
      provider,
      withoutClaim: "skip",
      logger,
    });
    expect(provider.getMessage).toHaveBeenCalledOnce();
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
