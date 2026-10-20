"use client";

import { useMemo, useSyncExternalStore } from "react";
import useSWR from "swr";
import type { UpcomingScheduledEmailsResponse } from "@/app/api/user/scheduled-emails/route";
import { useAllAccountsList } from "@/app/(app)/[emailAccountId]/mail/all-accounts-list";

type HiddenDrafts = { emailAccountId: string; messageIds: string[] };

const NO_HIDDEN_DRAFTS: HiddenDrafts[] = [];
const NO_MESSAGE_IDS: string[] = [];
let sendingDrafts = NO_HIDDEN_DRAFTS;
const listeners = new Set<() => void>();

const SCHEDULED_EMAILS_PATH = "/api/user/scheduled-emails";

export function upcomingScheduledEmailsKey(emailAccountId: string) {
  return [SCHEDULED_EMAILS_PATH, emailAccountId];
}

/**
 * Every listed account's sends waiting to go out, each read as its own
 * account. No accounts reads nothing.
 */
export function useAllAccountsUpcomingScheduledEmails(
  accounts: { id: string }[] | undefined,
) {
  return useAllAccountsList<UpcomingScheduledEmailsResponse>(
    SCHEDULED_EMAILS_PATH,
    accounts,
    {
      refreshInterval: (current) =>
        scheduledEmailsRefreshInterval(
          current?.byAccount.flatMap(({ data }) => data.scheduledEmails) ?? [],
        ),
    },
  );
}

/** Null reads nothing, as when the sends of several accounts are read instead. */
export function useUpcomingScheduledEmails(emailAccountId: string | null) {
  return useSWR<UpcomingScheduledEmailsResponse>(
    emailAccountId ? upcomingScheduledEmailsKey(emailAccountId) : null,
    {
      refreshInterval: (current) =>
        scheduledEmailsRefreshInterval(current?.scheduledEmails ?? []),
    },
  );
}

/** Soon after the next send is due, or often while one is going out. */
export function scheduledEmailsRefreshInterval(
  rows: UpcomingScheduledEmailsResponse["scheduledEmails"],
) {
  if (rows.some((row) => row.status === "PROCESSING")) return 5000;
  const dueTimes = rows
    .filter((row) => row.status === "PENDING")
    .map((row) => new Date(row.sendAt).getTime());
  return dueTimes.length
    ? Math.min(60_000, Math.max(5000, Math.min(...dueTimes) - Date.now()))
    : 0;
}

/**
 * Mailbox drafts that a send still waiting to go out will deliver from. The
 * send stands in for them, so they're hidden until it goes out, and come back
 * if it's cancelled or fails.
 */
export function useHiddenDraftMessageIds(emailAccountId: string) {
  const { data } = useUpcomingScheduledEmails(emailAccountId);
  const sending = useSyncExternalStore(
    subscribe,
    () => sendingDrafts,
    () => NO_HIDDEN_DRAFTS,
  );
  return useMemo(
    () => [
      ...getScheduledDraftMessageIds(data?.scheduledEmails ?? []),
      ...sending
        .filter((entry) => entry.emailAccountId === emailAccountId)
        .flatMap((entry) => entry.messageIds),
    ],
    [data, sending, emailAccountId],
  );
}

/** The same, for every account All inboxes merges. No accounts reads nothing. */
export function useAllAccountsHiddenDraftMessageIds(
  accounts: { id: string }[] | undefined,
) {
  const { data } = useAllAccountsUpcomingScheduledEmails(accounts);
  const sending = useSyncExternalStore(
    subscribe,
    () => sendingDrafts,
    () => NO_HIDDEN_DRAFTS,
  );
  const accountKey = accounts?.map((account) => account.id).join("\n");
  return useMemo(() => {
    if (accountKey === undefined) return NO_MESSAGE_IDS;
    const accountIds = new Set(accountKey.split("\n"));
    const ids = [
      ...getScheduledDraftMessageIds(
        data?.byAccount.flatMap(({ data }) => data.scheduledEmails) ?? [],
      ),
      ...sending
        .filter((entry) => accountIds.has(entry.emailAccountId))
        .flatMap((entry) => entry.messageIds),
    ];
    return ids.length ? ids : NO_MESSAGE_IDS;
  }, [accountKey, data, sending]);
}

/**
 * Hides a draft from this tab while its send is held for undo or queued on the
 * device, before the server knows about it, or once it is discarded and until
 * sync drops it. Returns a function that shows it again.
 */
export function hideSendingDraftMessages(
  emailAccountId: string,
  messageIds: string[],
) {
  if (!messageIds.length) return () => {};
  const entry = { emailAccountId, messageIds };
  sendingDrafts = [...sendingDrafts, entry];
  notify();
  return () => {
    if (!sendingDrafts.includes(entry)) return;
    sendingDrafts = sendingDrafts.filter((item) => item !== entry);
    notify();
  };
}

export function getScheduledDraftMessageIds(
  rows: UpcomingScheduledEmailsResponse["scheduledEmails"],
) {
  return rows.flatMap((row) =>
    row.status === "PENDING" || row.status === "PROCESSING"
      ? row.draftMessageIds
      : [],
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function notify() {
  for (const listener of listeners) listener();
}
