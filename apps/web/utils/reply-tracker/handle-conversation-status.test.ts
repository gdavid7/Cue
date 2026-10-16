import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  determineConversationStatus,
  updateThreadTrackers,
} from "@/utils/reply-tracker/handle-conversation-status";
import { aiDetermineThreadStatus } from "@/utils/ai/reply/determine-thread-status";
import { getEmailAccount, getMockMessage } from "@/__tests__/helpers";
import { SystemType, ThreadTrackerType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { publishTrackerHint } from "@/utils/redis/local-mail-hints";

vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/reply/determine-thread-status");
vi.mock("@/utils/redis/local-mail-hints", () => ({
  publishTrackerHint: vi.fn().mockResolvedValue(undefined),
}));

describe("determineConversationStatus", () => {
  const emailAccount = getEmailAccount();
  const conversationRules = [
    { id: "rule-fyi", systemType: SystemType.FYI, enabled: true },
  ] as any;
  const provider = {
    getThreadMessages: vi.fn(),
    isSentMessage: vi.fn((message: { headers: { from: string } }) =>
      message.headers.from.includes(emailAccount.email),
    ),
  };

  const inbound = getMockMessage({
    id: "inbound-1",
    from: "sender@example.com",
    to: emailAccount.email,
  });

  function run() {
    return determineConversationStatus({
      conversationRules,
      message: inbound as any,
      emailAccount,
      provider: provider as any,
      modelType: "default",
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(aiDetermineThreadStatus).mockResolvedValue({
      status: SystemType.FYI,
      rationale: "Informational",
    });
  });

  it("ignores a trailing filing assistant message", async () => {
    const filingNotification = getMockMessage({
      id: "filing-1",
      from: `Inbox Zero Assistant <${emailAccount.email}>`,
      to: emailAccount.email,
      subject: "✓ Filed Receipt.pdf",
    });
    provider.getThreadMessages.mockResolvedValue([inbound, filingNotification]);

    const result = await run();

    const args = vi.mocked(aiDetermineThreadStatus).mock.calls[0][0];
    expect(args.threadMessages.map((m) => m.id)).toEqual(["inbound-1"]);
    expect(args.userSentLastEmail).toBe(false);
    expect(result.rule?.id).toBe("rule-fyi");
  });

  it("keeps an ordinary trailing message from the user", async () => {
    const userReply = getMockMessage({
      id: "reply-1",
      from: emailAccount.email,
      to: "sender@example.com",
      subject: "Re: Test",
    });
    provider.getThreadMessages.mockResolvedValue([inbound, userReply]);

    await run();

    const args = vi.mocked(aiDetermineThreadStatus).mock.calls[0][0];
    expect(args.threadMessages.map((m) => m.id)).toEqual([
      "inbound-1",
      "reply-1",
    ]);
    expect(args.userSentLastEmail).toBe(true);
  });

  it("skips status determination when only assistant messages remain", async () => {
    provider.getThreadMessages.mockResolvedValue([
      getMockMessage({
        id: "filing-1",
        from: emailAccount.email,
        to: emailAccount.email,
        subject: "📄 Where should I file Contract.pdf?",
      }),
    ]);

    const result = await run();

    expect(aiDetermineThreadStatus).not.toHaveBeenCalled();
    expect(result.rule).toBeNull();
  });
});

describe("updateThreadTrackers", () => {
  it("reopens a message's tracker when it needs a reply again", async () => {
    // Needs reply reads open trackers, so a message marked again after its
    // tracker was resolved must come back rather than stay resolved.
    await updateThreadTrackers({
      emailAccountId: "account",
      threadId: "thread",
      messageId: "message",
      sentAt: new Date("2026-10-14T12:00:00Z"),
      status: SystemType.TO_REPLY,
    });

    expect(prisma.threadTracker.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { resolved: false, type: ThreadTrackerType.NEEDS_REPLY },
      }),
    );
  });

  it.each([
    SystemType.TO_REPLY,
    SystemType.FYI,
  ])("tells an open Today its lanes changed (%s)", async (status) => {
    vi.mocked(publishTrackerHint).mockClear();

    await updateThreadTrackers({
      emailAccountId: "account",
      threadId: "thread",
      messageId: "message",
      sentAt: new Date("2026-10-14T12:00:00Z"),
      status,
    });

    expect(publishTrackerHint).toHaveBeenCalledWith(
      "account",
      expect.anything(),
    );
  });
});
