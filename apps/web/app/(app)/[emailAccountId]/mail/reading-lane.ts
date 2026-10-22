import { formatSenders } from "@/app/(app)/[emailAccountId]/home/today-format";
import { isThreadUnread } from "@/app/(app)/[emailAccountId]/mail/read-state";
import { getThreadParticipantNames } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { MailSplitFilterKind } from "@/generated/prisma/enums";
import type { MailUrlView } from "@/utils/mail-url";
import type { ThreadsQuery } from "@/utils/threads/validation";

/** The mail view that reads through the newsletters the inbox bundles. */
export const MAIL_READING_TYPE = "reading";

/** Pages "Archive all" and "Mark all read" load before acting, at most. */
export const MAX_READING_DRAIN_PAGES = 10;

export function isReadingMailView(view: MailUrlView | undefined) {
  return view?.kind === "type" && view.type === MAIL_READING_TYPE;
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

/**
 * Where a Reading address stands. Only "lane" shows the lane, its bar and its
 * actions; anywhere else they would act on whatever list shows instead.
 * All inboxes, and an account with nothing filed as Newsletter, go back to
 * the inbox.
 */
export function getReadingRoute({
  isReadingView,
  isAllAccounts,
  readingLabelId,
  labelsLoading,
  labelsFailed,
}: {
  isReadingView: boolean;
  isAllAccounts: boolean;
  readingLabelId: string | undefined;
  labelsLoading: boolean;
  labelsFailed: boolean;
}): "off" | "resolving" | "failed" | "lane" | "redirect" {
  if (!isReadingView) return "off";
  if (isAllAccounts) return "redirect";
  if (readingLabelId) return "lane";
  if (labelsFailed) return "failed";
  if (labelsLoading) return "resolving";
  return "redirect";
}

/**
 * How "Archive all" or "Mark all read" reaches every newsletter: the rows
 * already loaded when that's all of them; a server job over the whole lane
 * where the provider can list it; otherwise the remaining pages are loaded
 * first.
 */
export function getReadingBulkPlan({
  hasMore,
  canMatch,
}: {
  hasMore: boolean;
  canMatch: boolean;
}): "loaded" | "matching" | "drain" {
  if (!hasMore) return "loaded";
  return canMatch ? "matching" : "drain";
}

/** "12", or "50+" while more are still to load. */
export function formatReadingCount(count: number, hasMore: boolean) {
  return hasMore ? `${count}+` : String(count);
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
