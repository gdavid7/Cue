import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { recordComposeAssistOutcomeAction } from "@/utils/actions/compose-assist";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
const mocks = vi.hoisted(() => ({ limited: false }));
vi.mock("@/utils/rate-limit", () => ({
  assertWithinUserRateLimit: vi.fn(async () => {
    if (mocks.limited) throw new Error("Rate limited");
  }),
}));

const OUTCOME = {
  outcome: "accepted" as const,
  request: "Shorter",
  refinements: [],
  original: "Thanks so much for getting back to me!",
  suggestion: "Thanks for the reply!",
};

describe("recordComposeAssistOutcomeAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limited = false;
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
    prisma.composeAssistReply.findFirst.mockResolvedValue(null);
  });

  it("starts a reply's record with its first outcome", async () => {
    await recordComposeAssistOutcomeAction("email-account-1", {
      threadId: "thread-1",
      messageId: "message-1",
      outcome: OUTCOME,
    });

    expect(prisma.composeAssistReply.create).toHaveBeenCalledWith({
      data: {
        emailAccountId: "email-account-1",
        threadId: "thread-1",
        messageId: "message-1",
        outcomes: [OUTCOME],
      },
    });
  });

  it("stores nothing once the user is over the rate limit", async () => {
    mocks.limited = true;

    const result = await recordComposeAssistOutcomeAction("email-account-1", {
      threadId: "thread-1",
      messageId: "message-1",
      outcome: OUTCOME,
    });

    expect(result?.serverError).toBeTruthy();
    expect(prisma.composeAssistReply.create).not.toHaveBeenCalled();
    expect(prisma.composeAssistReply.update).not.toHaveBeenCalled();
  });
});
