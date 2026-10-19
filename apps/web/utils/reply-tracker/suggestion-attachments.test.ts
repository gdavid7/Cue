import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { resolveActionAttachments } from "@/utils/ai/action-attachments";
import { attachRuleSuggestionFiles } from "./suggestion-attachments";

vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/action-attachments", () => ({
  resolveActionAttachments: vi.fn(),
}));

const logger = createTestLogger();
const emailAccount = { id: "account-1", userId: "user-1", email: "me@x.com" };

describe("attachRuleSuggestionFiles", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // D-084: the rule's files go with its reply once that reply is a draft.
  it("puts the rule's files on the draft the suggestion became", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      staticAttachments: [{ name: "lease.pdf" }],
      selectedAttachments: null,
      executedRule: { id: "run-1", messageId: "m1", ruleId: "rule-1" },
    } as never);
    vi.mocked(resolveActionAttachments).mockResolvedValue([
      {
        filename: "lease.pdf",
        content: Buffer.from("pdf"),
        contentType: "application/pdf",
      },
    ]);
    const listed = [{ id: "a1", filename: "lease.pdf" }];
    const provider = {
      addDraftAttachment: vi
        .fn()
        .mockResolvedValue({ attachments: listed, attachmentId: "a1" }),
    };

    const result = await attachRuleSuggestionFiles({
      provider: provider as never,
      draftId: "draft-1",
      executedActionId: "suggestion-1",
      emailAccount,
      logger,
    });

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "suggestion-1",
          draftId: null,
          executedRule: { emailAccountId: "account-1" },
        }),
      }),
    );
    expect(provider.addDraftAttachment).toHaveBeenCalledWith(
      "draft-1",
      expect.objectContaining({
        filename: "lease.pdf",
        mimeType: "application/pdf",
        size: 3,
        disposition: "attachment",
      }),
    );
    expect(result).toBe(listed);
  });

  it("adds nothing for another account's suggestion", async () => {
    prisma.executedAction.findFirst.mockResolvedValue(null);
    const provider = { addDraftAttachment: vi.fn() };

    const result = await attachRuleSuggestionFiles({
      provider: provider as never,
      draftId: "draft-1",
      executedActionId: "suggestion-1",
      emailAccount,
      logger,
    });

    expect(result).toBeNull();
    expect(provider.addDraftAttachment).not.toHaveBeenCalled();
  });
});
