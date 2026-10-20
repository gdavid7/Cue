import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { saveComposeDraftAction } from "@/utils/actions/mail";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const mocks = vi.hoisted(() => ({
  provider: {
    createDraft: vi.fn(),
    updateDraft: vi.fn(),
    getDraft: vi.fn(),
  },
  attachRuleSuggestionFiles: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: async () => mocks.provider,
}));
vi.mock("@/utils/reply-tracker/suggestion-attachments", () => ({
  attachRuleSuggestionFiles: mocks.attachRuleSuggestionFiles,
}));

const CONTENT = {
  to: "sender@example.com",
  subject: "Re: Lease",
  messageHtml: "<p>Here you go, with a note.</p>",
};

describe("saveComposeDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
    mocks.provider.createDraft.mockResolvedValue({ id: "draft-1" });
    mocks.provider.getDraft.mockResolvedValue({
      id: "msg-1",
      threadId: "thread-1",
    });
  });

  // D-084: the rule's files reach the mailbox with the draft its reply became.
  it("puts the rule's files on a new draft started from its suggestion", async () => {
    const listed = [{ id: "a1", filename: "lease.pdf" }];
    mocks.attachRuleSuggestionFiles.mockResolvedValue(listed);

    const result = await saveComposeDraftAction("email-account-1", {
      content: CONTENT,
      ruleSuggestionId: "suggestion-1",
    });

    expect(mocks.attachRuleSuggestionFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        draftId: "draft-1",
        executedActionId: "suggestion-1",
        emailAccount: expect.objectContaining({
          id: "email-account-1",
          userId: "user-1",
        }),
      }),
    );
    expect(result?.data).toMatchObject({
      draftId: "draft-1",
      attachments: listed,
    });
  });

  it("adds no files when the draft already exists", async () => {
    await saveComposeDraftAction("email-account-1", {
      draftId: "draft-1",
      content: CONTENT,
      ruleSuggestionId: "suggestion-1",
    });

    expect(mocks.attachRuleSuggestionFiles).not.toHaveBeenCalled();
  });
});
