import {
  getCueStripVisibility,
  getThreadCategories,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import type { EmailLabels } from "@/providers/email-label-types";
import { GmailLabel } from "@/utils/gmail/label";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

/**
 * The message whose brief a hover on this row may start, or null. Each brief
 * is a model call, so only when the Cue strip would show from what the row
 * already knows (a conversation category, or Cue's note asking the user to
 * reply or act), as `CueStrip` decides. A row with a draft is skipped: the
 * reader keys the brief by the newest message that isn't a draft, which the
 * row can't name for sure.
 */
export function getReaderPrefetchPlan({
  thread,
  insightData,
  userLabels,
  hasAiAccess,
}: {
  thread: ListThread;
  insightData: ThreadInsightData | undefined;
  userLabels: EmailLabels;
  hasAiAccess: boolean;
}): { messageId: string } | null {
  const latest = thread.messages.at(-1);
  if (!latest) return null;
  const hasDraft = thread.messages.some((message) =>
    message.labelIds?.includes(GmailLabel.DRAFT),
  );
  if (hasDraft) return null;
  // As the list asks for the row's note, so both name the same message.
  const messageId = thread.latestMessageId ?? latest.id;

  // Undefined while the row's note hasn't come; without AI access Cue writes
  // none, as the strip treats it.
  const insight = hasAiAccess ? insightData?.insight : null;
  const visibility = getCueStripVisibility({
    categories: getThreadCategories({
      messages: thread.messages,
      userLabels,
      plans: thread.plans ?? [],
    }),
    categoriesLoaded: true,
    insight,
  });

  return visibility === "show" ? { messageId } : null;
}
