import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { resolveMessagingContext } from "@/utils/messaging/chat-sdk/bot";

vi.mock("@/utils/prisma");

const logger = createTestLogger();

// After sharing, every mailbox of the person holds a link for the same Slack,
// Teams or Telegram user. Which mailbox answers must follow one rule: the
// mailbox the chat already belongs to, otherwise the originally connected one.
describe("choosing which mailbox answers a messaging user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.chat.findUnique.mockResolvedValue(null);
  });

  it("answers a new Telegram chat from the originally connected mailbox and names it", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      { emailAccountId: "work" },
      { emailAccountId: "personal" },
    ] as never);

    const context = await resolveMessagingContext({
      adapters: {} as never,
      thread: telegramThread(),
      message: telegramMessage(),
      logger,
    });

    expect(prisma.messagingChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    );
    expect(context?.emailAccountId).toBe("work");
    expect(context?.hasMultipleAccounts).toBe(true);
  });

  it("keeps a Telegram chat on the mailbox it already belongs to", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      { emailAccountId: "work" },
      { emailAccountId: "personal" },
    ] as never);
    prisma.chat.findUnique.mockResolvedValue({
      emailAccountId: "personal",
    } as never);

    const context = await resolveMessagingContext({
      adapters: {} as never,
      thread: telegramThread(),
      message: telegramMessage(),
      logger,
    });

    expect(context?.emailAccountId).toBe("personal");
  });

  it("answers a new Slack DM from the originally connected mailbox and names it when the person has several", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      slackCandidate("work"),
      slackCandidate("personal"),
    ] as never);

    const context = await resolveMessagingContext({
      adapters: {
        slack: {
          decodeThreadId: () => ({ channel: "D1", threadTs: "" }),
        },
      } as never,
      thread: {
        id: "slack:D1:",
        channelId: "D1",
        isDM: true,
        adapter: { name: "slack" },
      } as never,
      message: {
        text: "what's new?",
        attachments: [],
        author: { userId: "U1" },
        raw: { type: "message", team_id: "T1" },
      } as never,
      logger,
    });

    expect(prisma.messagingChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: "asc" } }),
    );
    expect(context?.emailAccountId).toBe("work");
    expect(context?.hasMultipleAccounts).toBe(true);
  });

  it("does not name the mailbox for a person with only one", async () => {
    prisma.messagingChannel.findMany.mockResolvedValue([
      slackCandidate("work"),
    ] as never);

    const context = await resolveMessagingContext({
      adapters: {
        slack: {
          decodeThreadId: () => ({ channel: "D1", threadTs: "" }),
        },
      } as never,
      thread: {
        id: "slack:D1:",
        channelId: "D1",
        isDM: true,
        adapter: { name: "slack" },
      } as never,
      message: {
        text: "what's new?",
        attachments: [],
        author: { userId: "U1" },
        raw: { type: "message", team_id: "T1" },
      } as never,
      logger,
    });

    expect(context?.hasMultipleAccounts).toBe(false);
  });
});

function slackCandidate(emailAccountId: string) {
  return {
    id: `channel-${emailAccountId}`,
    accessToken: "xoxb",
    botUserId: "B1",
    emailAccountId,
    routes: [],
  };
}

function telegramThread() {
  return {
    id: "telegram:42",
    channelId: "42",
    isDM: true,
    adapter: { name: "telegram" },
  } as never;
}

function telegramMessage() {
  return {
    text: "what's new?",
    attachments: [],
    author: { userId: "tg-user" },
    raw: { chat: { id: 42, type: "private" } },
  } as never;
}
