"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type { ConversationQuery } from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { createBrowserCache } from "@/utils/browser-cache";
import type { TodayAccount, TodayThread } from "@/utils/home/merge-home";
import { isLocalMailReady, localTodayThread } from "./use-local-inbox-rows";

const WAITING_ON_YOU_LIMIT = 5;
const WINDOW_MS = 14 * 86_400_000;
// Read past the five shown, so a few dismissals don't empty the group.
const READ_LIMIT = 25;
const NO_ROWS: TodayThread[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

// Per user and account, cleared on sign-out and account removal. A
// dismissal outlives the window its row could show in only as clutter.
const dismissals = createBrowserCache<true>({
  name: "waiting-on-you-dismissed",
  ttlMs: WINDOW_MS,
  maxEntries: 200,
});

/**
 * Today's Waiting on you: recent inbox conversations whose newest message is
 * from someone the user writes to, read from this browser's local mail with
 * no model, so a new mailbox has something to answer before Cue has read it.
 * Empty until every account's first sync has finished and the labels Cue
 * files are known. Dismissing a row is kept in this browser only, until the
 * conversation gets a newer message.
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
  /**
   * By account, the labels of mail Cue files, which is left to Cue. Nothing
   * shows until they're known, so filed mail never flashes in.
   */
  handledLabelIds?: Record<string, string[]>;
  enabled: boolean;
}): { threads: TodayThread[]; dismiss: (thread: TodayThread) => void } {
  const client = useOptionalMailClient();
  const queryWaitingOnYou = client?.queryWaitingOnYou?.bind(client);
  const active = enabled && Boolean(queryWaitingOnYou) && accounts.length > 0;
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  // The newest inbox and sent rows. The inbox's says whether the store is
  // ready. Each view republishes only when its rows, counts or coverage
  // change, so between them a new message or a reply the user sent, here or
  // elsewhere, reads the list again; a change deeper in the inbox that moves
  // neither waits for the next one.
  const inbox = useMailboxWindow(
    useMemo(() => newestIn(accountIds, "inbox"), [accountIds]),
    { client, enabled: active },
  );
  const sent = useMailboxWindow(
    useMemo(() => newestIn(accountIds, "sent"), [accountIds]),
    { client, enabled: active },
  );
  const ready =
    active &&
    handledLabelIds !== undefined &&
    inbox.status === "ready" &&
    Boolean(inbox.data && isLocalMailReady(inbox.data, accounts));

  const { data } = useSWR(
    ready && queryWaitingOnYou
      ? [
          "waiting-on-you",
          accountIds.join(","),
          JSON.stringify(handledLabelIds),
          inbox.revision?.databaseEpoch,
          inbox.revision?.sequence,
          sent.revision?.sequence,
        ]
      : null,
    () =>
      queryWaitingOnYou?.({
        accountIds,
        ownAddresses: accounts.map((account) => account.email),
        receivedSinceMs: Date.now() - WINDOW_MS,
        excludedLabelIds: handledLabelIds,
        limit: READ_LIMIT,
      }) ?? [],
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // An older tab owning the engine, or the in-tab engine, can't answer.
      shouldRetryOnError: false,
    },
  );

  // The browser cache doesn't tell anyone when it changes, so what is
  // dismissed here is also kept here to update at once.
  const [dismissedHere, setDismissedHere] = useState(NO_KEYS);
  const threads = useMemo(() => {
    if (!ready || !data) return NO_ROWS;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return data
      .filter((conversation) => {
        const key = dismissalKey(conversation);
        return (
          !dismissedHere.has(`${conversation.accountId}:${key}`) &&
          !isWaitingOnYouDismissed(conversation.accountId, conversation)
        );
      })
      .slice(0, WAITING_ON_YOU_LIMIT)
      .flatMap((conversation) => {
        const account = byId.get(conversation.accountId);
        if (!account) return [];
        const row = localTodayThread({
          conversationId: conversation.conversationId,
          messageId: conversation.messageId,
          counterpart: conversation.from,
          subject: conversation.subject,
          preview: conversation.preview,
          atMs: conversation.receivedAtMs,
          unread: conversation.unread,
          starred: conversation.starred,
        });
        return [named ? { ...row, account } : row];
      });
  }, [ready, data, accounts, dismissedHere, named]);

  const dismiss = useCallback(
    (thread: TodayThread) => {
      const accountId = thread.account?.id ?? accounts[0]?.id;
      if (!accountId) return;
      const conversation = {
        conversationId: thread.threadId,
        messageId: thread.messageId,
      };
      dismissWaitingOnYou(accountId, conversation);
      setDismissedHere((current) =>
        new Set(current).add(`${accountId}:${dismissalKey(conversation)}`),
      );
    },
    [accounts],
  );

  return { threads, dismiss };
}

/** Leaves the conversation out in this browser until a newer message. */
export function dismissWaitingOnYou(
  accountId: string,
  conversation: { conversationId: string; messageId: string },
) {
  dismissals.set(accountId, dismissalKey(conversation), true);
}

/** Whether this browser was asked to leave the conversation out. */
export function isWaitingOnYouDismissed(
  accountId: string,
  conversation: { conversationId: string; messageId: string },
) {
  return dismissals.get(accountId, dismissalKey(conversation)) === true;
}

// The newest message is part of it, so a later message brings it back.
function dismissalKey(conversation: {
  conversationId: string;
  messageId: string;
}) {
  return `${conversation.conversationId}:${conversation.messageId}`;
}

function newestIn(
  accountIds: string[],
  mailbox: "inbox" | "sent",
): ConversationQuery {
  return {
    accountIds,
    predicate: { kind: "mailbox", mailbox },
    order: "newest_first",
    pageSize: 1,
    after: null,
  };
}
