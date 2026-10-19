import { ActionType, DraftEmailStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import {
  canWriteRequestedReplies,
  type DraftRepliesSetting,
} from "@/utils/rule/draft-replies-enabled";
import { DRAFT_WINDOW_DAYS } from "@/utils/reply-tracker/suggestion-window";

/**
 * Which of these messages have a reply Cue already wrote waiting for them, a
 * rule's or a pre-draft, as the reader would open it: kept in Cue, not yet
 * dismissed, sent or turned into a mailbox draft, and recent. Message IDs
 * only. None while "Auto draft replies" is off, as the reader shows none then.
 */
export async function getReadySuggestionMessageIds({
  emailAccountId,
  messageIds,
  draftReplies,
  now = new Date(),
}: {
  emailAccountId: string;
  messageIds: string[];
  draftReplies: DraftRepliesSetting;
  now?: Date;
}): Promise<Set<string>> {
  if (!messageIds.length || !canWriteRequestedReplies(draftReplies))
    return new Set();

  const actions = await prisma.executedAction.findMany({
    where: {
      type: ActionType.DRAFT_EMAIL,
      draftId: null,
      draftStatus: DraftEmailStatus.PENDING,
      AND: [{ content: { not: null } }, { content: { not: "" } }],
      suggestedReplyDraft: null,
      createdAt: {
        gte: new Date(now.getTime() - DRAFT_WINDOW_DAYS * 86_400_000),
      },
      executedRule: { emailAccountId, messageId: { in: messageIds } },
    },
    select: { executedRule: { select: { messageId: true } } },
  });
  return new Set(actions.map((action) => action.executedRule.messageId));
}
