import type {
  MatchingBulkAction,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import { isMicrosoftProvider } from "@/utils/email/provider-types";
import type { ThreadsQuery } from "@/utils/threads/validation";
import {
  MAIL_FILES_TYPE,
  MAIL_SCHEDULED_TYPE,
  MAIL_SNOOZED_TYPE,
} from "@/app/(app)/[emailAccountId]/mail/MailSidebar";

// Destructive actions over more conversations than this ask first.
const MATCHING_CONFIRM_THRESHOLD = 100;

const SCOPE_KEYS = new Set([
  "q",
  "type",
  "labelId",
  "labelIds",
  "folderId",
  "isUnread",
  "limit",
  "nextPageToken",
]);

/**
 * The list's query as a scope the server can list in full, or null when the
 * view is sliced in a way only the list itself applies (split filters, Cue's
 * own sorting, Focused/Other) and so can't be acted on beyond its rows.
 */
export function getMatchingScope(
  query: ThreadsQuery,
  provider: string | null | undefined,
): MatchingScope | null {
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && !value.length) continue;
    if (!SCOPE_KEYS.has(key)) return null;
  }
  if (
    query.type === MAIL_SCHEDULED_TYPE ||
    query.type === MAIL_SNOOZED_TYPE ||
    query.type === MAIL_FILES_TYPE
  )
    return null;
  if (
    isMicrosoftProvider(provider) &&
    (query.labelId || query.labelIds?.length)
  )
    return null;

  const scope: MatchingScope = {};
  if (query.q) scope.q = query.q;
  if (query.type) scope.type = query.type;
  if (query.labelId) scope.labelId = query.labelId;
  if (query.labelIds?.length) scope.labelIds = query.labelIds;
  if (query.folderId) scope.folderId = query.folderId;
  if (query.isUnread) scope.isUnread = true;
  return scope;
}

export function getMatchingBannerCopy({
  pageCount,
  total,
  viewTitle,
  isSearch,
  active,
}: {
  pageCount: number;
  /** Every conversation in the view, when the provider knows exactly. */
  total: number | null;
  viewTitle: string;
  isSearch: boolean;
  active: boolean;
}) {
  const where = isSearch ? "that match this search" : `in ${viewTitle}`;
  const all = total === null ? "" : ` ${formatCount(total)}`;
  if (active) {
    return {
      message: `All${all} conversations ${where} are selected.`,
      action: "Clear selection",
    };
  }
  return {
    message: `All ${formatCount(pageCount)} conversations on this page are selected.`,
    action: `Select all${all} conversations ${where}`,
  };
}

export function needsMatchingConfirm(
  action: MatchingBulkAction,
  total: number | null,
) {
  if (action === "delete_forever") return true;
  if (action !== "trash" && action !== "spam") return false;
  return total === null || total > MATCHING_CONFIRM_THRESHOLD;
}

export function getMatchingConfirmCopy(
  action: MatchingBulkAction,
  total: number | null,
) {
  const conversations =
    total === null ? "every conversation" : conversationCount(total);
  switch (action) {
    case "delete_forever":
      return {
        title: `Delete ${conversations} forever?`,
        description: "They'll be gone for good. This can't be undone.",
        confirm: "Delete forever",
      };
    case "spam":
      return {
        title: `Report ${conversations} as spam?`,
        description:
          "They'll move to Spam, and the mail stays there until you move it back.",
        confirm: "Report spam",
      };
    default:
      return {
        title: `Delete ${conversations}?`,
        description:
          "They'll move to Trash. You can restore them from there for 30 days.",
        confirm: "Delete",
      };
  }
}

function conversationCount(count: number) {
  return `${formatCount(count)} ${count === 1 ? "conversation" : "conversations"}`;
}

function formatCount(count: number) {
  return count.toLocaleString("en-US");
}
