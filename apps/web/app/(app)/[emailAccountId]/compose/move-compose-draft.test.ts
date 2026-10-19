import { beforeEach, describe, expect, it, vi } from "vitest";
import { discardComposeDraftAction } from "@/utils/actions/mail";
import {
  createReplyDraftWriter,
  getReplyDraft,
} from "@/utils/mail-engine/reply-drafts";
import {
  finishComposeDraftMove,
  getMoveErrorMessage,
} from "./move-compose-draft";
import { forgetAttachedFiles } from "./upload-draft-attachment";

vi.mock("@/utils/actions/mail", () => ({
  discardComposeDraftAction: vi.fn(),
}));
vi.mock("@/utils/mail-engine/reply-drafts", () => ({
  getReplyDraft: vi.fn(),
  createReplyDraftWriter: vi.fn(),
}));
vi.mock("./upload-draft-attachment", () => ({
  forgetAttachedFiles: vi.fn(),
}));
const mailClient = vi.hoisted(() => ({
  forgetDeletedDrafts: vi.fn(async () => {}),
}));
vi.mock("@/utils/mail-engine/active-client", () => ({
  getActiveMailClient: () => mailClient,
}));

const localDraft = {
  emailAccountId: "account-a",
  threadId: "compose:new-message",
  messageId: "compose:new-message",
};
const from = {
  emailAccountId: "account-a",
  localDraft,
  draftId: "draft-a",
  attachmentIds: ["file-1"],
};

describe("finishComposeDraftMove", () => {
  const clear = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(discardComposeDraftAction).mockResolvedValue({
      data: { success: true, deletedMessageId: "message-a2" },
    } as never);
    vi.mocked(getReplyDraft).mockResolvedValue({
      ...localDraft,
      content: { providerDraftMessageIds: ["message-a1"] } as never,
      revision: 4,
      updatedAt: 0,
    });
    vi.mocked(createReplyDraftWriter).mockReturnValue({
      clear,
      save: vi.fn(),
    } as never);
  });

  it("removes the old account's drafts once the new mailbox holds the message", async () => {
    const result = await finishComposeDraftMove({
      from,
      newMailboxDraftId: "draft-b",
      filesMoved: true,
    });

    expect(result).toBe("moved");
    expect(discardComposeDraftAction).toHaveBeenCalledWith("account-a", {
      draftId: "draft-a",
    });
    expect(createReplyDraftWriter).toHaveBeenCalledWith(localDraft, 4);
    expect(clear).toHaveBeenCalledOnce();
    expect(forgetAttachedFiles).toHaveBeenCalledWith("account-a", ["file-1"]);
    // Gone from the old account's local Drafts too, so a reload can't show it.
    expect(mailClient.forgetDeletedDrafts).toHaveBeenCalledWith({
      accountId: "account-a",
      messageIds: ["message-a1", "message-a2"],
    });
  });

  // The new account's device copy can vanish with the tab or a private
  // window, so only its mailbox draft makes the old drafts safe to remove.
  it("keeps every old draft until the new mailbox holds the message", async () => {
    const result = await finishComposeDraftMove({
      from,
      newMailboxDraftId: undefined,
      filesMoved: true,
    });

    expect(result).toBe("kept");
    expect(discardComposeDraftAction).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
    expect(forgetAttachedFiles).not.toHaveBeenCalled();
  });

  it("keeps the old mailbox draft, which still has the files, when a file did not move", async () => {
    const result = await finishComposeDraftMove({
      from,
      newMailboxDraftId: "draft-b",
      filesMoved: false,
    });

    expect(result).toBe("moved");
    expect(discardComposeDraftAction).not.toHaveBeenCalled();
    expect(clear).toHaveBeenCalledOnce();
  });

  it("keeps the old local draft when its mailbox draft could not be removed", async () => {
    vi.mocked(discardComposeDraftAction).mockResolvedValue({
      serverError: "Gmail is unavailable.",
    } as never);

    await expect(
      finishComposeDraftMove({
        from,
        newMailboxDraftId: "draft-b",
        filesMoved: true,
      }),
    ).rejects.toThrow("Gmail is unavailable.");
    expect(clear).not.toHaveBeenCalled();
    expect(mailClient.forgetDeletedDrafts).not.toHaveBeenCalled();
  });
});

describe("getMoveErrorMessage", () => {
  it("shows the failure's own message", () => {
    expect(getMoveErrorMessage(new Error("Gmail is unavailable."))).toBe(
      "Gmail is unavailable.",
    );
  });

  it("falls back to saying the draft could not move", () => {
    expect(getMoveErrorMessage("unknown")).toBe("Could not move this draft.");
  });
});
