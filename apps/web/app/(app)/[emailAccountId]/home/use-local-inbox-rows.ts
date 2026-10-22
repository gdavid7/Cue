"use client";

import { useMemo } from "react";
import type {
  ConversationQuery,
  ConversationSummary,
  MailboxView,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import { getFirstSyncAccountIds } from "@/utils/mail-engine/coverage";
import {
  type TodayAccount,
  type TodayThread,
  todayConversationKey,
} from "@/utils/home/merge-home";
import { HANDLED_WINDOW_DAYS } from "@/utils/home/today-constants";

// Today shows five, but those the server puts under Needs reply and mail Cue
// filed are left out, so read the most one page holds: a local read is cheap.
const PAGE_SIZE = 100;
const NO_HANDLED_LABELS: Record<string, string[]> = {};

/**
 * The inbox as this browser's local mail store holds it, newest first, as
 * Today's rows: what "Also in your inbox" shows while the server's answer is
 * on its way. Null while the store can't answer for every account, as when
 * the engine is starting, an account's first sync hasn't finished or it
 * can't reach the provider; Today then waits for the server as before.
 */
export function useLocalInboxRows({
  accounts,
  named,
  handledLabelIds = NO_HANDLED_LABELS,
  enabled,
}: {
  accounts: TodayAccount[];
  /** Across accounts each row names its account, as the server's do. */
  named: boolean;
  /**
   * By account, the labels of mail Cue files without asking, from a server
   * answer. Missing before the first one, when filed mail can still show.
   */
  handledLabelIds?: Record<string, string[]>;
  enabled: boolean;
}): TodayThread[] | null {
  const client = useOptionalMailClient();
  const active = enabled && Boolean(client) && accounts.length > 0;
  const query = useMemo<ConversationQuery>(
    () => ({
      accountIds: accounts.map((account) => account.id),
      predicate: { kind: "mailbox", mailbox: "inbox" },
      order: "newest_first",
      pageSize: PAGE_SIZE,
      after: null,
    }),
    [accounts],
  );
  const mailbox = useMailboxWindow(query, { client, enabled: active });
  const view = active && mailbox.status === "ready" ? mailbox.data : null;
  return useMemo(
    () =>
      view ? localInboxRows(view, { accounts, named, handledLabelIds }) : null,
    [view, accounts, named, handledLabelIds],
  );
}

/** The view's conversations as Today's rows, or null if it can't answer yet. */
export function localInboxRows(
  view: MailboxView,
  {
    accounts,
    named,
    handledLabelIds = NO_HANDLED_LABELS,
    now = Date.now(),
  }: {
    accounts: TodayAccount[];
    named: boolean;
    handledLabelIds?: Record<string, string[]>;
    now?: number;
  },
): TodayThread[] | null {
  if (!isLocalMailReady(view, accounts)) return null;
  const byId = new Map(accounts.map((account) => [account.id, account]));
  const handledSince = now - HANDLED_WINDOW_DAYS * 86_400_000;
  const rows = view.conversations.flatMap((conversation) => {
    // Only the accounts asked for, so another mailbox's rows never show.
    const account = byId.get(conversation.key.accountId);
    if (!account) return [];
    // As the server's answer does, mail Cue filed lately is left to Cue.
    const handled = handledLabelIds[account.id] ?? [];
    if (
      conversation.latestMessageAtMs >= handledSince &&
      conversation.labelIds.some((id) => handled.includes(id))
    )
      return [];
    const row = toTodayThread(conversation, account.email);
    if (!row) return [];
    return [named ? { ...row, account } : row];
  });
  return named ? showCopiesOnce(rows) : rows;
}

/**
 * Whether the local store can answer for every account: the engine reaches
 * the provider and each account's first sync has finished.
 */
export function isLocalMailReady(view: MailboxView, accounts: TodayAccount[]) {
  if (view.connection && view.connection !== "ready") return false;
  const accountIds = accounts.map((account) => account.id);
  return getFirstSyncAccountIds(accountIds, view.coverage).length === 0;
}

/**
 * A message in two of the user's mailboxes shows once, newest copy first, and
 * says where else it is, as Today's merge of the server's rows does.
 */
function showCopiesOnce(rows: TodayThread[]) {
  const shown = new Map<string, TodayThread>();
  return rows.filter((row) => {
    const key = todayConversationKey(row);
    const first = shown.get(key);
    if (!first) {
      shown.set(key, row);
      return true;
    }
    if (!row.account || first.account?.id === row.account.id) return true;
    if (!first.alsoIn?.some(({ id }) => id === row.account?.id))
      first.alsoIn = [...(first.alsoIn ?? []), row.account];
    return false;
  });
}

function toTodayThread(
  conversation: ConversationSummary,
  ownEmail: string,
): TodayThread | null {
  // A conversation that is only a draft isn't mail in the inbox yet.
  if (!conversation.latestMessageId) return null;
  // Who the conversation is with, as the server's rows say: the latest sender
  // who isn't the user, or the first recipient when the user wrote last.
  const own = ownEmail.toLowerCase();
  const other = conversation.senders.findLast(
    (sender) => extractEmailAddress(sender).toLowerCase() !== own,
  );
  const counterpart =
    other ||
    splitRecipientList(conversation.to)[0] ||
    conversation.to ||
    conversation.from;
  return {
    threadId: conversation.key.conversationId,
    fromName:
      extractNameFromEmail(counterpart) || extractEmailAddress(counterpart),
    fromEmail: extractEmailAddress(counterpart),
    subject: (conversation.subject || "(no subject)").replace(
      /^((re|fwd?):\s*)+/i,
      "",
    ),
    preview: conversation.preview,
    at: new Date(conversation.latestMessageAtMs).toISOString(),
    priority: conversation.unread ? "medium" : "low",
    unread: conversation.unread,
    messageId: conversation.latestMessageId,
    ...(conversation.latestInternetMessageId
      ? { rfcMessageId: conversation.latestInternetMessageId }
      : {}),
    starred: conversation.starred,
    inInbox: true,
  };
}
