"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { ConversationQuery } from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { createBrowserCache } from "@/utils/browser-cache";
import { isMetadataCoverageComplete } from "@/utils/mail-engine/coverage";
import type { TodayAccount, TodayThread } from "@/utils/home/merge-home";
import { isLocalMailReady, localTodayThread } from "./use-local-inbox-rows";

const WAITING_ON_YOU_LIMIT = 5;
const WINDOW_MS = 14 * 86_400_000;
// A first sync stores the last few days whole before it backfills older mail
// (Gmail's first scan is three days of everything). Until the backfill ends,
// an older conversation may lack the reply the user sent, so only these days
// show, and older ones join below once the store holds them.
const SYNCING_WINDOW_MS = 3 * 86_400_000;
// Read past the five shown, so a few dismissals don't empty the group.
const READ_LIMIT = 25;
// Rows that left, remembered in their places for an undo to bring back.
const MAX_REMEMBERED = 50;
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
 * files are known. Rows keep their places as more mail syncs in: newer mail
 * joins on top, older below. Dismissing a row is kept in this browser only,
 * until the conversation gets a newer message.
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
  const syncing = !isMetadataCoverageComplete(inbox.data?.coverage ?? []);

  const { data } = useSWR(
    ready && queryWaitingOnYou
      ? [
          "waiting-on-you",
          accountIds.join(","),
          JSON.stringify(handledLabelIds),
          inbox.revision?.databaseEpoch,
          inbox.revision?.sequence,
          sent.revision?.sequence,
          syncing,
        ]
      : null,
    () =>
      queryWaitingOnYou?.({
        accountIds,
        ownAddresses: accounts.map((account) => account.email),
        receivedSinceMs: Date.now() - (syncing ? SYNCING_WINDOW_MS : WINDOW_MS),
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
  // What showed last, in order, with the rows that have since left. Only
  // ever set to what the same inputs give, so rendering twice gives the
  // same rows.
  const shownKeys = useRef<readonly string[]>([]);
  const threads = useMemo(() => {
    if (!ready || !data) return NO_ROWS;
    const byId = new Map(accounts.map((account) => [account.id, account]));
    const showable = data.filter((conversation) => {
      const key = dismissalKey(conversation);
      return (
        !dismissedHere.has(`${conversation.accountId}:${key}`) &&
        !isWaitingOnYouDismissed(conversation.accountId, conversation)
      );
    });
    const shown = keepShownOrder(
      shownKeys.current,
      showable,
      WAITING_ON_YOU_LIMIT,
    );
    shownKeys.current = rememberShownOrder(shownKeys.current, shown, showable);
    return shown.flatMap((conversation) => {
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

/**
 * The newest of `conversations`, up to `limit`, with those already shown kept
 * in their order: one newer than all of them goes on top, as new mail does,
 * and any other goes below, so a row that syncs in late never pushes the
 * rows under it down. `conversations` is newest first.
 */
export function keepShownOrder<
  T extends {
    accountId: string;
    conversationId: string;
    messageId: string;
    receivedAtMs: number;
  },
>(shownBefore: readonly string[], conversations: T[], limit: number): T[] {
  const byKey = new Map(
    conversations.map((conversation) => [shownKey(conversation), conversation]),
  );
  const kept = shownBefore.flatMap((key) => byKey.get(key) ?? []);
  const keptKeys = new Set(kept.map(shownKey));
  const newestKeptMs = Math.max(
    ...kept.map((conversation) => conversation.receivedAtMs),
  );
  const added = conversations.filter(
    (conversation) => !keptKeys.has(shownKey(conversation)),
  );
  return [
    ...added.filter((conversation) => conversation.receivedAtMs > newestKeptMs),
    ...kept,
    ...added.filter(
      (conversation) => conversation.receivedAtMs <= newestKeptMs,
    ),
  ].slice(0, limit);
}

/**
 * The order to keep next time: what `shown` holds, with the rows shown
 * before that have since left the store (archived, snoozed) kept in their
 * places, so an undo that brings one back puts it where it was rather than
 * below whatever filled its place. A row still in `conversations` but pushed
 * past the limit is let go.
 */
export function rememberShownOrder<
  T extends { accountId: string; conversationId: string; messageId: string },
>(shownBefore: readonly string[], shown: T[], conversations: T[]): string[] {
  const present = new Set(conversations.map(shownKey));
  const order = shown.map(shownKey);
  let at = 0;
  for (const key of shownBefore) {
    const index = order.indexOf(key);
    if (index >= 0) at = index + 1;
    else if (!present.has(key)) order.splice(at++, 0, key);
  }
  return order.slice(0, MAX_REMEMBERED);
}

// A newer message makes it a new row, which goes where new mail does.
function shownKey(conversation: {
  accountId: string;
  conversationId: string;
  messageId: string;
}) {
  return `${conversation.accountId}:${dismissalKey(conversation)}`;
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
