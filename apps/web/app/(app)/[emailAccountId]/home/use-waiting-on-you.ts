"use client";

import { useCallback, useMemo } from "react";
import useSWR from "swr";
import { useLocalStorage } from "usehooks-ts";
import type {
  ConversationQuery,
  WaitingOnYouConversation,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import type { TodayAccount, TodayThread } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

export const WAITING_ON_YOU_LIMIT = 5;
const WINDOW_DAYS = 14;
const DAY_MS = 86_400_000;
// Dismissals beyond this many only cost a longer read.
const MAX_DISMISSED_READ = 50;
const DISMISSED_STORAGE_KEY = "today-waiting-on-you-dismissed";
const NO_DISMISSED: Record<string, number> = {};
const NO_ROWS: TodayThread[] = [];

/**
 * Today's Waiting on you: recent inbox conversations whose newest message is
 * from someone the user writes to, read from this browser's local mail with
 * no model, so a new mailbox has something to answer before Cue has read it.
 * Empty until every account's first sync has finished. Dismissing a row is
 * kept in this browser only, until the conversation gets a newer message.
 */
export function useWaitingOnYou({
  accounts,
  named,
  handledLabelIds,
  enabled,
}: {
  accounts: TodayAccount[];
  /** Across accounts each row names its account. */
  named: boolean;
  /** By account, the labels of mail Cue files, which is left to Cue. */
  handledLabelIds?: Record<string, string[]>;
  enabled: boolean;
}): { threads: TodayThread[]; dismiss: (thread: TodayThread) => void } {
  const client = useOptionalMailClient();
  const queryWaitingOnYou = client?.queryWaitingOnYou?.bind(client);
  const active = enabled && Boolean(queryWaitingOnYou) && accounts.length > 0;
  // One inbox row is enough to know the store is ready, and its revision
  // changes with every write, which is when the list is read again.
  const readiness = useMemo<ConversationQuery>(
    () => ({
      accountIds: accounts.map((account) => account.id),
      predicate: { kind: "mailbox", mailbox: "inbox" },
      order: "newest_first",
      pageSize: 1,
      after: null,
    }),
    [accounts],
  );
  const mailbox = useMailboxWindow(readiness, { client, enabled: active });
  const ready =
    active &&
    mailbox.status === "ready" &&
    Boolean(mailbox.data && isLocalMailReady(mailbox.data, accounts));

  const [dismissed, setDismissed] = useLocalStorage(
    DISMISSED_STORAGE_KEY,
    NO_DISMISSED,
  );
  const limit = Math.min(
    WAITING_ON_YOU_LIMIT + Object.keys(dismissed).length,
    MAX_DISMISSED_READ,
  );
  const { data } = useSWR(
    ready && queryWaitingOnYou
      ? [
          "waiting-on-you",
          readiness.accountIds.join(","),
          JSON.stringify(handledLabelIds ?? {}),
          limit,
          mailbox.revision?.databaseEpoch,
          mailbox.revision?.sequence,
        ]
      : null,
    () =>
      queryWaitingOnYou?.({
        accountIds: readiness.accountIds,
        ownAddresses: accounts.map((account) => account.email),
        receivedSinceMs: Date.now() - WINDOW_DAYS * DAY_MS,
        excludedLabelIds: handledLabelIds,
        limit,
      }) ?? [],
    { keepPreviousData: true, revalidateOnFocus: false },
  );

  const threads = useMemo(() => {
    if (!ready || !data) return NO_ROWS;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return data
      .filter((conversation) => !dismissed[dismissKey(conversation)])
      .slice(0, WAITING_ON_YOU_LIMIT)
      .flatMap((conversation) => {
        const account = byId.get(conversation.accountId);
        if (!account) return [];
        const row = toTodayThread(conversation);
        return [named ? { ...row, account } : row];
      });
  }, [ready, data, accounts, dismissed, named]);

  const dismiss = useCallback(
    (thread: TodayThread) => {
      const accountId = thread.account?.id ?? accounts[0]?.id;
      if (!accountId) return;
      const key = dismissKey({
        accountId,
        conversationId: thread.threadId,
        messageId: thread.messageId,
      });
      const since = Date.now() - WINDOW_DAYS * DAY_MS;
      // A dismissal outlives the window it could show in only as clutter.
      setDismissed((current: Record<string, number>) => ({
        ...Object.fromEntries(
          Object.entries(current).filter(([, at]) => at >= since),
        ),
        [key]: Date.now(),
      }));
    },
    [accounts, setDismissed],
  );

  return { threads, dismiss };
}

// The newest message is part of it, so a later message brings it back.
function dismissKey(conversation: {
  accountId: string;
  conversationId: string;
  messageId: string;
}) {
  return `${conversation.accountId}:${conversation.conversationId}:${conversation.messageId}`;
}

function toTodayThread(conversation: WaitingOnYouConversation): TodayThread {
  return {
    threadId: conversation.conversationId,
    fromName:
      extractNameFromEmail(conversation.from) ||
      extractEmailAddress(conversation.from),
    fromEmail: extractEmailAddress(conversation.from),
    subject: (conversation.subject || "(no subject)").replace(
      /^((re|fwd?):\s*)+/i,
      "",
    ),
    preview: conversation.preview,
    at: new Date(conversation.receivedAtMs).toISOString(),
    priority: conversation.unread ? "medium" : "low",
    unread: conversation.unread,
    messageId: conversation.messageId,
    starred: conversation.starred,
    inInbox: true,
  };
}
