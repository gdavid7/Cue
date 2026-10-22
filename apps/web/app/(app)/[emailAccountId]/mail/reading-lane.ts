import { formatSenders } from "@/app/(app)/[emailAccountId]/home/today-format";
import { isThreadUnread } from "@/app/(app)/[emailAccountId]/mail/read-state";
import { getThreadParticipantNames } from "@/app/(app)/[emailAccountId]/mail/thread-participants";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { MailSplitFilterKind, SystemType } from "@/generated/prisma/enums";
import type { CueMembership } from "@/utils/split-inbox/cue-filter";
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
 * What says a conversation is a newsletter: the mailbox's Newsletter label
 * (an Outlook category), and Cue's own sorting, which most accounts rely on
 * as Cue doesn't label the mailbox by default. `byCue` is false only once
 * Cue's sorting has loaded with no newsletters, so the lane keeps the
 * label's own, cheaper query.
 */
export type ReadingSources = { labelId: string | undefined; byCue: boolean };

/**
 * Where Reading's newsletters come from for the lane, which waits for Cue's
 * sorting rather than act on part of the lane, and for the inbox, which never
 * waits on it: until it loads, only the label bundles.
 */
export function getReadingSources({
  labelId,
  cueMembership,
}: {
  labelId: string | undefined;
  /** Undefined while it loads. */
  cueMembership: CueMembership | undefined;
}): { lane: ReadingSources; inbox: ReadingSources } {
  const hasCueNewsletters = Boolean(cueMembership?.NEWSLETTER.length);
  return {
    lane: { labelId, byCue: !cueMembership || hasCueNewsletters },
    inbox: { labelId, byCue: hasCueNewsletters },
  };
}

/**
 * Newsletters still in the inbox, read or not, so one being read keeps its
 * place while the user reads through them. Each conversation once, whether
 * the label, Cue's sorting or both say so. Null when nothing could.
 */
export function readingLaneQuery({
  labelId,
  byCue,
}: ReadingSources): ThreadsQuery | null {
  if (!byCue) return labelId ? { labelIds: ["INBOX", labelId] } : null;
  return {
    type: "inbox",
    anyOf: [...(labelId ? [{ labelId }] : []), { cue: SystemType.NEWSLETTER }],
  };
}

/**
 * The inbox without them, as one Reading row stands in for them. Null when
 * nothing says which mail is a newsletter, so there is nothing to bundle.
 */
export function inboxWithoutReadingQuery({
  labelId,
  byCue,
}: ReadingSources): ThreadsQuery | null {
  const excludeSplits: NonNullable<ThreadsQuery["excludeSplits"]> = [];
  if (labelId)
    excludeSplits.push({
      matchAll: true,
      filters: [{ kind: MailSplitFilterKind.LABEL, value: labelId }],
    });
  if (byCue)
    excludeSplits.push({
      matchAll: true,
      filters: [
        { kind: MailSplitFilterKind.CUE, value: SystemType.NEWSLETTER },
      ],
    });
  return excludeSplits.length ? { type: "inbox", excludeSplits } : null;
}

/**
 * Where a Reading address stands. Only "lane" shows the lane, its bar and its
 * actions; anywhere else they would act on whatever list shows instead.
 * All inboxes, and an account where neither the label nor Cue's sorting
 * names any newsletter, go back to the inbox.
 */
export function getReadingRoute({
  isReadingView,
  isAllAccounts,
  readingLabelId,
  hasLaneQuery,
  labelsLoading,
  labelsFailed,
}: {
  isReadingView: boolean;
  isAllAccounts: boolean;
  readingLabelId: string | undefined;
  /** See `readingLaneQuery`. */
  hasLaneQuery: boolean;
  labelsLoading: boolean;
  labelsFailed: boolean;
}): "off" | "resolving" | "failed" | "lane" | "redirect" {
  if (!isReadingView) return "off";
  if (isAllAccounts) return "redirect";
  if (readingLabelId) return "lane";
  // Cue's sorting alone still makes a lane, once the labels have had their say.
  if (labelsFailed) return hasLaneQuery ? "lane" : "failed";
  if (labelsLoading) return "resolving";
  return hasLaneQuery ? "lane" : "redirect";
}

/**
 * How "Archive all" or "Mark all read" reaches every newsletter: the rows
 * already loaded when that's all of them; a server job over the whole lane
 * where the provider can list it (the label alone, on Gmail); otherwise, as
 * for Cue's sorting, which no mailbox search can express, the remaining pages
 * are loaded first, up to `MAX_READING_DRAIN_PAGES`.
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
