import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getMockMessage } from "@/__tests__/helpers";

const { createEmailProviderMock, removeLabelsMock, saveFeedbackMock } =
  vi.hoisted(() => ({
    createEmailProviderMock: vi.fn(),
    removeLabelsMock: vi.fn(),
    saveFeedbackMock: vi.fn(),
  }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: createEmailProviderMock,
}));
vi.mock("@/utils/reply-tracker/label-helpers", () => ({
  removeConflictingThreadStatusLabels: removeLabelsMock,
}));
vi.mock("@/utils/rule/classification-feedback", () => ({
  saveClassificationFeedback: saveFeedbackMock,
}));

import { markNoReplyNeededAction } from "@/utils/actions/rule-feedback";

describe("markNoReplyNeededAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: { userId: "user-1", provider: "google" },
    } as never);
    prisma.threadTracker.findFirst.mockResolvedValue({
      messageId: "message-1",
    } as never);
    prisma.threadTracker.updateMany.mockResolvedValue({ count: 1 });
    prisma.rule.findUnique.mockResolvedValue({ id: "to-reply-rule" } as never);
    createEmailProviderMock.mockResolvedValue({
      getMessage: vi.fn(async () =>
        getMockMessage({ id: "message-1", from: "Sarah <sarah@acme.com>" }),
      ),
    });
    removeLabelsMock.mockResolvedValue(true);
  });

  it("takes the thread off Needs reply and teaches the To Reply rule", async () => {
    const result = await markNoReplyNeededAction("account-1", {
      threadId: "thread-1",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.threadTracker.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        threadId: "thread-1",
        type: "NEEDS_REPLY",
        resolved: false,
      },
      data: { resolved: true },
    });
    expect(removeLabelsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        threadId: "thread-1",
      }),
    );
    expect(saveFeedbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "account-1",
        ruleId: "to-reply-rule",
        sender: "sarah@acme.com",
        messageId: "message-1",
        eventType: "LABEL_REMOVED",
      }),
    );
  });

  it("still clears the thread when the mailbox can't be reached", async () => {
    createEmailProviderMock.mockRejectedValue(new Error("token expired"));

    const result = await markNoReplyNeededAction("account-1", {
      threadId: "thread-1",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.threadTracker.updateMany).toHaveBeenCalled();
    expect(saveFeedbackMock).not.toHaveBeenCalled();
  });
});
