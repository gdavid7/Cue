import { beforeEach, describe, expect, it, vi } from "vitest";
import { discardComposeDraftAction } from "@/utils/actions/mail";
import {
  createReplyDraftWriter,
  getReplyDraft,
} from "@/utils/mail-engine/reply-drafts";
import { finishComposeDraftMove } from "./move-compose-draft";
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
      data: { success: true },
    } as never);
    vi.mocked(getReplyDraft).mockResolvedValue({
      ...localDraft,
      content: {} as never,
      revision: 4,
      updatedAt: 0,
    });
    vi.mocked(createReplyDraftWriter).mockReturnValue({
      clear,
      save: vi.fn(),
    } as never);
  });

  it("removes the old account's drafts once the new account saved the message", async () => {
    const result = await finishComposeDraftMove({
      from,
      savedOnNewAccount: true,
      filesMoved: true,
    });

    expect(result).toBe("moved");
    expect(discardComposeDraftAction).toHaveBeenCalledWith("account-a", {
      draftId: "draft-a",
    });
    expect(createReplyDraftWriter).toHaveBeenCalledWith(localDraft, 4);
    expect(clear).toHaveBeenCalledOnce();
    expect(forgetAttachedFiles).toHaveBeenCalledWith("account-a", ["file-1"]);
  });

  // H1: until the new account holds the message, the old drafts are all
  // there is, so nothing of them is removed.
  it("keeps every old draft when the new account could not save the message", async () => {
    const result = await finishComposeDraftMove({
      from,
      savedOnNewAccount: false,
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
      savedOnNewAccount: true,
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
        savedOnNewAccount: true,
        filesMoved: true,
      }),
    ).rejects.toThrow("Gmail is unavailable.");
    expect(clear).not.toHaveBeenCalled();
  });
});
