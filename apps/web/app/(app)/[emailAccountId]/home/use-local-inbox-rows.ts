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
import type { TodayAccount, TodayThread } from "@/utils/home/merge-home";
import { ALSO_IN_INBOX_LIMIT } from "@/utils/home/today-cache";
import { HOME_LANE_LIMIT } from "@/utils/home/today-constants";

const MAX_PAGE_SIZE = 100;

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
  enabled,
}: {
  accounts: TodayAccount[];
  /** Across accounts each row names its account, as the server's do. */
  named: boolean;
  enabled: boolean;
}): TodayThread[] | null {
  const client = useOptionalMailClient();
  const active = enabled && Boolean(client) && accounts.length > 0;
  const query = useMemo<ConversationQuery>(
    () => ({
      accountIds: accounts.map((account) => account.id),
      predicate: { kind: "mailbox", mailbox: "inbox" },
      order: "newest_first",
      // Room for the rows the server puts under Needs reply instead.
      pageSize: Math.min(
        MAX_PAGE_SIZE,
        ALSO_IN_INBOX_LIMIT + HOME_LANE_LIMIT * accounts.length,
      ),
      after: null,
    }),
    [accounts],
  );
  const mailbox = useMailboxWindow(query, { client, enabled: active });
  const view = active && mailbox.status === "ready" ? mailbox.data : null;
  return useMemo(
    () => (view ? localInboxRows(view, { accounts, named }) : null),
    [view, accounts, named],
  );
}

/** The view's conversations as Today's rows, or null if it can't answer yet. */
export function localInboxRows(
  view: MailboxView,
  { accounts, named }: { accounts: TodayAccount[]; named: boolean },
): TodayThread[] | null {
  const accountIds = accounts.map((account) => account.id);
  if (view.connection && view.connection !== "ready") return null;
  if (getFirstSyncAccountIds(accountIds, view.coverage).length) return null;
  const byId = new Map(accounts.map((account) => [account.id, account]));
  return view.conversations.flatMap((conversation) => {
    // Only the accounts asked for, so another mailbox's rows never show.
    const account = byId.get(conversation.key.accountId);
    if (!account) return [];
    const row = toTodayThread(conversation, account.email);
    if (!row) return [];
    return [named ? { ...row, account } : row];
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
    starred: conversation.starred,
    inInbox: true,
  };
}
