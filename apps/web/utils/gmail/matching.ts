import type { gmail_v1 } from "@googleapis/gmail";
import type {
  MatchingFilter,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import { getGmailViewLabelIds, GmailLabel } from "@/utils/gmail/label";
import { withGmailRetry } from "@/utils/gmail/retry";
import { queryIncludesSpamOrTrash } from "@/utils/gmail/thread";

// The most messages.list returns in one page.
const MATCHING_PAGE_SIZE = 500;

/** The messages.list arguments for every message a scope holds. */
export function gmailMatchingListQuery(
  scope: MatchingScope,
  only: MatchingFilter,
) {
  const labelIds = [...(scopeLabelIds(scope) ?? [])];
  if (only.inInbox && !labelIds.includes(GmailLabel.INBOX))
    labelIds.push(GmailLabel.INBOX);

  const queryParts: string[] = [];
  if (scope.q) queryParts.push(scope.q);
  if (scope.type === "archive") queryParts.push(`-in:${GmailLabel.INBOX}`);
  if (scope.isUnread) queryParts.push("is:unread");
  if (only.unread === true) queryParts.push("is:unread");
  if (only.unread === false) queryParts.push("-is:unread");
  const q = queryParts.length ? queryParts.join(" ") : undefined;

  return {
    labelIds,
    q,
    includeSpamTrash:
      labelIds.some(
        (labelId) =>
          labelId === GmailLabel.SPAM || labelId === GmailLabel.TRASH,
      ) || queryIncludesSpamOrTrash(q ?? ""),
  };
}

export async function listGmailMatchingMessages({
  gmail,
  scope,
  only,
  pageToken,
}: {
  gmail: gmail_v1.Gmail;
  scope: MatchingScope;
  only: MatchingFilter;
  pageToken?: string;
}) {
  const response = await withGmailRetry(() =>
    gmail.users.messages.list({
      userId: "me",
      ...gmailMatchingListQuery(scope, only),
      maxResults: MATCHING_PAGE_SIZE,
      pageToken,
      fields: "messages(id,threadId),nextPageToken",
    }),
  );

  return {
    messages: (response.data.messages ?? []).flatMap((message) =>
      message.id && message.threadId
        ? [{ id: message.id, threadId: message.threadId }]
        : [],
    ),
    nextPageToken: response.data.nextPageToken ?? undefined,
  };
}

/**
 * How many conversations a scope holds, when Gmail knows it exactly: a view
 * of one label, optionally its unread part. A search only has Gmail's rough
 * estimate, so it has no count.
 */
export async function countGmailMatchingConversations({
  gmail,
  scope,
}: {
  gmail: gmail_v1.Gmail;
  scope: MatchingScope;
}): Promise<number | null> {
  if (scope.q || scope.type === "archive") return null;
  const labelIds = scopeLabelIds(scope);
  if (labelIds?.length !== 1) return null;

  const response = await withGmailRetry(() =>
    gmail.users.labels.get({ userId: "me", id: labelIds[0] }),
  );
  const count = scope.isUnread
    ? response.data.threadsUnread
    : response.data.threadsTotal;
  return typeof count === "number" ? count : null;
}

function scopeLabelIds(scope: MatchingScope) {
  if (scope.labelIds?.length) return scope.labelIds;
  if (scope.labelId) return [scope.labelId];
  // A search covers the whole mailbox, as Gmail's own search box does.
  if (scope.q && !scope.type) return [];
  return getGmailViewLabelIds(scope.type);
}
