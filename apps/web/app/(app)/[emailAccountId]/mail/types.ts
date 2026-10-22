import type { CombinedListThread } from "@/utils/threads/load-combined";
import type { ThreadListItem } from "@/utils/threads/load";

export type ListThread = (ThreadListItem | CombinedListThread) & {
  /**
   * The newest real message. Rows built from the local mail engine carry
   * placeholder message ids, so this is the one to send to the server.
   */
  latestMessageId?: string;
  /** That message's Message-ID, on rows built from the local mail. */
  latestInternetMessageId?: string;
  hasAttachments?: boolean;
};
export type ListMessage = ListThread["messages"][number];

/** One rule execution for a message in a thread, with its matched reason. */
export type ThreadPlan = NonNullable<ListThread["plans"]>[number];

/** Split view is the two-column list + reader; list view gives the list the full width. */
export type MailLayoutMode = "list" | "split";

export type ThreadSelection = {
  emailAccountId: string;
  threadId: string;
};

export function isCombinedListThread(
  thread: ListThread,
): thread is CombinedListThread {
  return "account" in thread;
}

/**
 * What thread actions need to know about a conversation, so a list outside the
 * mailbox, such as Today, can use them. Only combined-inbox rows carry `account`.
 */
export type ActionableThread = {
  id: string;
  account?: { id: string };
  messageIds?: string[];
  messages?: Array<{ id: string }>;
  /** Copies of the row's message in other accounts, hidden behind it. */
  copies?: Array<{ accountId: string; threadId: string }>;
};

export function getListThreadKey(thread: ActionableThread) {
  return thread.account ? `${thread.account.id}:${thread.id}` : thread.id;
}

export function getListThreadMessageIds(thread: ActionableThread) {
  return thread.messageIds?.length
    ? thread.messageIds
    : (thread.messages?.map((message) => message.id) ?? []);
}

export function getListThreadEmailAccountId(
  thread: ActionableThread,
  currentEmailAccountId: string,
) {
  return thread.account?.id ?? currentEmailAccountId;
}

/**
 * The account a sent reply belongs to. A held send settles after the user may
 * have opened another thread, so the open thread only counts when it is the
 * one replied to.
 */
export function getRepliedThreadEmailAccountId({
  repliedThreadId,
  openSelection,
  threads,
  currentEmailAccountId,
}: {
  repliedThreadId: string;
  openSelection: ThreadSelection | null;
  threads: ActionableThread[];
  currentEmailAccountId: string;
}) {
  if (openSelection?.threadId === repliedThreadId)
    return openSelection.emailAccountId;
  const thread = threads.find((item) => item.id === repliedThreadId);
  return thread
    ? getListThreadEmailAccountId(thread, currentEmailAccountId)
    : currentEmailAccountId;
}

export function getListThreadSelection(
  thread: ListThread,
  currentEmailAccountId: string,
): ThreadSelection {
  return {
    emailAccountId: getListThreadEmailAccountId(thread, currentEmailAccountId),
    threadId: thread.id,
  };
}

export function getThreadSelectionKey(selection: ThreadSelection | null) {
  return selection ? `${selection.emailAccountId}:${selection.threadId}` : null;
}
