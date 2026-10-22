import type { gmail_v1 } from "@googleapis/gmail";
import type {
  MatchingFilter,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import {
  GMAIL_SYSTEM_LABELS,
  getGmailViewLabelIds,
  GmailLabel,
} from "@/utils/gmail/label";
import { mapWithConcurrency } from "@/utils/async";
import { withGmailRetry } from "@/utils/gmail/retry";
import { searchReachesSpamOrTrash } from "@/utils/mail-search/search-query-predicate";

// The most messages.list returns in one page.
const MATCHING_PAGE_SIZE = 500;
const CONVERSATION_CONCURRENCY = 5;

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
      ) || searchReachesSpamOrTrash(q ?? "", "google"),
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

  const messages = (response.data.messages ?? []).flatMap((message) =>
    message.id && message.threadId
      ? [{ id: message.id, threadId: message.threadId }]
      : [],
  );
  return {
    messages: actsOnConversations(scope, only)
      ? await withConversationMessages({ gmail, messages, only })
      : messages,
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

/**
 * A label's view holds conversations, as Gmail's own select-all treats it:
 * archiving or changing read state reaches every message of each one, not
 * just those carrying the label, or a digest whose replies lack it would stay
 * behind. System views and searches stay per message.
 */
function actsOnConversations(scope: MatchingScope, only: MatchingFilter) {
  const changesState = only.inInbox || only.unread !== undefined;
  const namesUserLabel = (scopeLabelIds(scope) ?? []).some(
    (labelId) => !GMAIL_SYSTEM_LABELS.includes(labelId),
  );
  return Boolean(changesState && namesUserLabel);
}

/** The page's conversations' messages the action would change, each once. */
async function withConversationMessages({
  gmail,
  messages,
  only,
}: {
  gmail: gmail_v1.Gmail;
  messages: { id: string; threadId: string }[];
  only: MatchingFilter;
}) {
  const threadIds = [...new Set(messages.map((message) => message.threadId))];
  const threads = await mapWithConcurrency(
    threadIds,
    CONVERSATION_CONCURRENCY,
    (threadId) =>
      withGmailRetry(() =>
        gmail.users.threads.get({
          userId: "me",
          id: threadId,
          format: "minimal",
          fields: "messages(id,threadId,labelIds)",
        }),
      ),
  );
  const changes = (labelIds: string[]) => {
    if (only.inInbox && !labelIds.includes(GmailLabel.INBOX)) return false;
    if (only.unread === true) return labelIds.includes(GmailLabel.UNREAD);
    if (only.unread === false) return !labelIds.includes(GmailLabel.UNREAD);
    return true;
  };
  const seen = new Set<string>();
  return threads.flatMap((thread) =>
    (thread.data.messages ?? []).flatMap((message) => {
      if (!message.id || !message.threadId || seen.has(message.id)) return [];
      if (!changes(message.labelIds ?? [])) return [];
      seen.add(message.id);
      return [{ id: message.id, threadId: message.threadId }];
    }),
  );
}
