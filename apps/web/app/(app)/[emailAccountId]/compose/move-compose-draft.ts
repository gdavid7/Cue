import { discardComposeDraftAction } from "@/utils/actions/mail";
import { getActionErrorMessage } from "@/utils/error";
import {
  createReplyDraftWriter,
  getReplyDraft,
  type ReplyDraftIdentity,
} from "@/utils/mail-engine/reply-drafts";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import { forgetDeletedDrafts } from "@/utils/mail-engine/forget-deleted-drafts";
import { forgetAttachedFiles } from "./upload-draft-attachment";

/** What a new message left on the account it was moved away from. */
export type MovedFromDraft = {
  emailAccountId: string;
  localDraft?: ReplyDraftIdentity;
  draftId?: string;
  attachmentIds: string[];
};

/**
 * Removes the old account's copy of a message moved to another account, but
 * only once the new account's mailbox holds it. A copy on this device can be
 * lost with the tab or a private window, so it doesn't count. A file that
 * didn't reach the new draft keeps the old mailbox draft, which still has it.
 */
export async function finishComposeDraftMove({
  from,
  newMailboxDraftId,
  filesMoved,
}: {
  from: MovedFromDraft;
  newMailboxDraftId: string | undefined;
  filesMoved: boolean;
}): Promise<"moved" | "kept"> {
  if (!newMailboxDraftId) return "kept";
  const stored = from.localDraft
    ? await getReplyDraft(from.localDraft)
    : undefined;
  if (from.draftId && filesMoved) {
    const result = await discardComposeDraftAction(from.emailAccountId, {
      draftId: from.draftId,
    });
    if (!result?.data) throw new Error(getActionErrorMessage(result ?? {}));
    await forgetDeletedDrafts(getActiveMailClient(), from.emailAccountId, [
      ...(stored?.content?.providerDraftMessageIds ?? []),
      result.data.deletedMessageId,
    ]);
  }
  if (from.localDraft && stored?.content)
    await createReplyDraftWriter(from.localDraft, stored.revision).clear();
  forgetAttachedFiles(from.emailAccountId, from.attachmentIds);
  return "moved";
}

export function getMoveErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Could not move this draft.";
}
