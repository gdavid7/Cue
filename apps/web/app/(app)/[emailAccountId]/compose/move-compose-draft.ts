import { discardComposeDraftAction } from "@/utils/actions/mail";
import { getActionErrorMessage } from "@/utils/error";
import {
  createReplyDraftWriter,
  getReplyDraft,
  type ReplyDraftIdentity,
} from "@/utils/mail-engine/reply-drafts";
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
 * only once the new account holds it: until then the old drafts are all
 * there is. A file that didn't reach the new draft keeps the old mailbox
 * draft, which still has it.
 */
export async function finishComposeDraftMove({
  from,
  savedOnNewAccount,
  filesMoved,
}: {
  from: MovedFromDraft;
  savedOnNewAccount: boolean;
  filesMoved: boolean;
}): Promise<"moved" | "kept"> {
  if (!savedOnNewAccount) return "kept";
  if (from.draftId && filesMoved) {
    const result = await discardComposeDraftAction(from.emailAccountId, {
      draftId: from.draftId,
    });
    if (!result?.data) throw new Error(getActionErrorMessage(result ?? {}));
  }
  if (from.localDraft) {
    const stored = await getReplyDraft(from.localDraft);
    if (stored?.content)
      await createReplyDraftWriter(from.localDraft, stored.revision).clear();
  }
  forgetAttachedFiles(from.emailAccountId, from.attachmentIds);
  return "moved";
}
