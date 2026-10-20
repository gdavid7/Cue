import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { resolveActionAttachmentsWithFailures } from "@/utils/ai/action-attachments";
import { attachRuleSuggestionFiles } from "./suggestion-attachments";

vi.mock("@/utils/prisma");
vi.mock("@/utils/ai/action-attachments", () => ({
  resolveActionAttachmentsWithFailures: vi.fn(),
}));

const logger = createTestLogger();
const emailAccount = { id: "account-1", userId: "user-1", email: "me@x.com" };
const LEASE = {
  filename: "lease.pdf",
  content: Buffer.from("pdf"),
  contentType: "application/pdf",
};

describe("attachRuleSuggestionFiles", () => {
  let provider: {
    addDraftAttachment: ReturnType<typeof vi.fn>;
    deleteDraft: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.executedAction.findFirst.mockResolvedValue({
      staticAttachments: [{ type: "FILE", name: "lease.pdf" }],
      selectedAttachments: null,
      executedRule: { id: "run-1", messageId: "m1", ruleId: "rule-1" },
    } as never);
    provider = {
      addDraftAttachment: vi.fn(),
      deleteDraft: vi.fn().mockResolvedValue(true),
    };
  });

  function attach(filenames?: string[]) {
    return attachRuleSuggestionFiles({
      provider: provider as never,
      draftId: "draft-1",
      executedActionId: "suggestion-1",
      filenames,
      emailAccount,
      logger,
    });
  }

  // D-084: the rule's files go with its reply once that reply is a draft.
  it("puts the files the user kept on the draft the suggestion became", async () => {
    vi.mocked(resolveActionAttachmentsWithFailures).mockResolvedValue({
      attachments: [LEASE],
      failedFilenames: [],
    });
    const listed = [{ id: "a1", filename: "lease.pdf" }];
    provider.addDraftAttachment.mockResolvedValue({
      attachments: listed,
      attachmentId: "a1",
    });

    const result = await attach(["lease.pdf"]);

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: "suggestion-1",
          draftId: null,
          executedRule: { emailAccountId: "account-1" },
        }),
      }),
    );
    expect(resolveActionAttachmentsWithFailures).toHaveBeenCalledWith(
      expect.objectContaining({ onlyFilenames: ["lease.pdf"] }),
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
    expect(provider.deleteDraft).not.toHaveBeenCalled();
  });

  // Told "Attaches lease.pdf", the user must not send without it.
  it("stops, names the file and removes the draft when Drive can't fetch it", async () => {
    vi.mocked(resolveActionAttachmentsWithFailures).mockResolvedValue({
      attachments: [],
      failedFilenames: ["lease.pdf"],
    });

    await expect(attach()).rejects.toThrow(
      "Couldn't attach lease.pdf. Try again or remove it.",
    );
    expect(provider.addDraftAttachment).not.toHaveBeenCalled();
    // Trying again makes a new draft, not a second one beside this.
    expect(provider.deleteDraft).toHaveBeenCalledWith("draft-1");
  });

  it("removes the draft when the mailbox won't take the file", async () => {
    vi.mocked(resolveActionAttachmentsWithFailures).mockResolvedValue({
      attachments: [LEASE],
      failedFilenames: [],
    });
    provider.addDraftAttachment.mockRejectedValue(new Error("413"));

    await expect(attach()).rejects.toThrow(
      "Couldn't attach lease.pdf. Try again or remove it.",
    );
    expect(provider.deleteDraft).toHaveBeenCalledWith("draft-1");
  });

  it("adds nothing for another account's suggestion", async () => {
    prisma.executedAction.findFirst.mockResolvedValue(null);

    expect(await attach()).toBeNull();
    expect(provider.addDraftAttachment).not.toHaveBeenCalled();
    expect(provider.deleteDraft).not.toHaveBeenCalled();
  });
});
