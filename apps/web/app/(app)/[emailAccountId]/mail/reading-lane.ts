import { formatSenders } from "@/app/(app)/[emailAccountId]/home/today-format";
import { isThreadUnread } from "@/app/(app)/[emailAccountId]/mail/read-state";
import { getThreadParticipantNames } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { MailSplitFilterKind, SystemType } from "@/generated/prisma/enums";
import { getRuleLabel } from "@/utils/rule/consts";
import type { ThreadsQuery } from "@/utils/threads/validation";

/** The mail view that reads through the newsletters the inbox bundles. */
export const MAIL_READING_TYPE = "reading";

/**
 * The label (an Outlook category) Cue files newsletters under, the one
 * Today's Reading lane reads too. Undefined when the account has none.
 */
export function findReadingLabelId(
  labels: readonly { id: string; name: string }[],
) {
  const wanted = getRuleLabel(SystemType.NEWSLETTER).toLowerCase();
  return labels.find((label) => label.name.trim().toLowerCase() === wanted)?.id;
}

/**
 * Newsletters still in the inbox, read or not, so one being read keeps its
 * place while the user reads through them.
 */
export function readingLaneQuery(labelId: string): ThreadsQuery {
  return { labelIds: ["INBOX", labelId] };
}

/** The inbox without them, as one Reading row stands in for them. */
export function inboxWithoutReadingQuery(labelId: string): ThreadsQuery {
  return {
    type: "inbox",
    excludeSplits: [
      {
        matchAll: true,
        filters: [{ kind: MailSplitFilterKind.LABEL, value: labelId }],
      },
    ],
  };
}

/** Who the newsletters are from, newest first, and how many are unread. */
export function getReadingSummary(threads: ListThread[], userEmail: string) {
  return {
    senders: formatSenders(
      threads.map(
        (thread) =>
          getThreadParticipantNames(thread.messages, userEmail)[0] ?? "",
      ),
    ),
    unreadCount: threads.filter((thread) => isThreadUnread(thread.messages))
      .length,
  };
}
