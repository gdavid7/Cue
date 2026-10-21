import {
  getCueStripVisibility,
  getThreadCategories,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import type { EmailLabels } from "@/providers/email-label-types";
import { extractEmailAddress, isSameEmailAddress } from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

/**
 * What the reader would ask for if this row were opened now, judged from the
 * row alone, so a hover prefetches only what the reader is sure to show:
 * - the brief only when the Cue strip would show from what the row already
 *   knows (a conversation category, or Cue's note asking the user to reply or
 *   act), as `CueStrip` decides, since each brief is a model call;
 * - the related context only when someone else wrote the newest message, as
 *   the reader shows it only then.
 * A row with a draft is skipped: the reader keys both by the newest message
 * that isn't a draft, which the row can't name for sure.
 */
export function getReaderPrefetchPlan({
  thread,
  insightData,
  userLabels,
  accountEmail,
  hasAiAccess,
}: {
  thread: ListThread;
  insightData: ThreadInsightData | undefined;
  userLabels: EmailLabels;
  accountEmail: string;
  hasAiAccess: boolean;
}): { messageId: string; brief: boolean; context: boolean } | null {
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

  const incoming =
    !latest.labelIds?.includes(GmailLabel.SENT) &&
    !isSameEmailAddress(extractEmailAddress(latest.headers.from), accountEmail);

  return { messageId, brief: visibility === "show", context: incoming };
}
