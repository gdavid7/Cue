"use client";

import { useMemo, useSyncExternalStore } from "react";
import useSWR, { type ScopedMutator } from "swr";
import { z } from "zod";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationStatus } from "@inboxzero/mail-core/operations";
import type { UpcomingScheduledEmailsResponse } from "@/app/api/user/scheduled-emails/route";
import { useAllAccountsList } from "@/hooks/useAllAccountsList";
import {
  getActiveMailClient,
  observeOperationOnActiveEngine,
  subscribeActiveMailClient,
  subscribeMailEngineLogout,
} from "@/utils/mail-engine/active-client";

export type HiddenDrafts = { emailAccountId: string; messageIds: string[] };

// A queued or held send outlives the page that sent it, so its drafts stay
// hidden on the next page in this tab. Ids only, never content.
const SENDING_DRAFTS_STORAGE_KEY = "cue:sending-drafts";
const MAX_STORED_SENDS = 50;
// A draft saved many times has a copy per save; its latest ones are kept.
const MAX_STORED_MESSAGE_IDS = 50;
// Sends that won't go out, or may not have: their drafts are the user's again,
// as the server's list shows them. A send waiting for a reconnect still goes
// out once the account is back, so its draft stays hidden meanwhile.
const UNSENT_STATUSES = new Set<OperationStatus>([
  "cancelled",
  "superseded",
  "failed",
  "needs_attention",
  "uncertain",
]);

const storedSendSchema = z.object({
  emailAccountId: z.string().min(1),
  operationId: z.string().min(1),
  messageIds: z.array(z.string().min(1)).max(MAX_STORED_MESSAGE_IDS),
});
type SendingDrafts = HiddenDrafts & { operationId?: string };

const NO_HIDDEN_DRAFTS: SendingDrafts[] = [];
const NO_HIDDEN_BY_ACCOUNT: HiddenDrafts[] = [];
let sendingDrafts: SendingDrafts[] = readStoredSends();
const listeners = new Set<() => void>();

const SCHEDULED_EMAILS_PATH = "/api/user/scheduled-emails";

/**
 * Re-reads an account's sends waiting to go out wherever they are read: alone,
 * or among All inboxes' accounts, which hide drafts by them too. A failed
 * read is stale data, not a failed action, so it never rejects.
 */
export async function refreshUpcomingScheduledEmails(
  mutate: ScopedMutator,
  emailAccountId: string,
) {
  await mutate(
    (key) =>
      Array.isArray(key) &&
      key[0] === SCHEDULED_EMAILS_PATH &&
      key.includes(emailAccountId),
  ).catch(() => {});
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
      ...(data?.sentDraftMessageIds ?? []),
      ...getScheduledDraftMessageIds(data?.scheduledEmails ?? []),
      ...sending
        .filter((entry) => entry.emailAccountId === emailAccountId)
        .flatMap((entry) => entry.messageIds),
    ],
    [data, sending, emailAccountId],
  );
}

/**
 * The same, for every account All inboxes merges, each account's apart: a
 * message id names a message only within its own account. No accounts reads
 * nothing.
 */
export function useAllAccountsHiddenDraftMessageIds(
  accounts: { id: string }[] | undefined,
): HiddenDrafts[] {
  const { data } = useAllAccountsUpcomingScheduledEmails(accounts);
  const sending = useSyncExternalStore(
    subscribe,
    () => sendingDrafts,
    () => NO_HIDDEN_DRAFTS,
  );
  const accountKey = accounts?.map((account) => account.id).join("\n");
  return useMemo(() => {
    if (accountKey === undefined) return NO_HIDDEN_BY_ACCOUNT;
    const hidden = accountKey.split("\n").flatMap((emailAccountId) => {
      const upcoming = data?.byAccount.find(
        (entry) => entry.accountId === emailAccountId,
      )?.data;
      const messageIds = [
        ...(upcoming?.sentDraftMessageIds ?? []),
        ...getScheduledDraftMessageIds(upcoming?.scheduledEmails ?? []),
        ...sending
          .filter((entry) => entry.emailAccountId === emailAccountId)
          .flatMap((entry) => entry.messageIds),
      ];
      return messageIds.length ? [{ emailAccountId, messageIds }] : [];
    });
    return hidden.length ? hidden : NO_HIDDEN_BY_ACCOUNT;
  }, [accountKey, data, sending]);
}

/**
 * Hides a draft from this tab while its send is held for undo or queued on the
 * device, before the server knows about it, or once it is discarded and until
 * sync drops it. A send's drafts stay hidden across a reload, until
 * `resumeSendingDrafts` sees it won't go out. Returns a function that shows
 * them again.
 */
export function hideSendingDraftMessages(
  emailAccountId: string,
  messageIds: string[],
  operationId?: string,
) {
  if (!messageIds.length) return () => {};
  const entry: SendingDrafts = operationId
    ? {
        emailAccountId,
        messageIds: messageIds.slice(-MAX_STORED_MESSAGE_IDS),
        operationId,
      }
    : { emailAccountId, messageIds };
  sendingDrafts = [...sendingDrafts, entry];
  if (operationId) storeSends();
  notify();
  return () => showDrafts(entry);
}

/**
 * Watches every send whose drafts this tab hid, including those an earlier
 * page in it queued, once this page's engine is running, and shows a draft
 * again if its send won't go out. Signing out forgets them. Returns a function
 * that stops watching.
 */
export function resumeSendingDrafts() {
  const watched = new Map<SendingDrafts, { close(): void }>();
  let client: MailClient | null = null;
  const sync = () => {
    client ??= getActiveMailClient();
    for (const [entry, handle] of watched) {
      if (sendingDrafts.includes(entry)) continue;
      handle.close();
      watched.delete(entry);
    }
    if (!client) return;
    for (const entry of sendingDrafts) {
      if (!entry.operationId || watched.has(entry)) continue;
      const handle = observeOperationOnActiveEngine(client, {
        accountId: entry.emailAccountId,
        operationId: entry.operationId,
      });
      watched.set(entry, handle);
      const inspect = () => {
        // The engine reads a send it has no record of as failed, so a draft
        // whose send is gone from this device is shown again rather than
        // hidden for good.
        const status = handle.getSnapshot().data?.status;
        if (status && UNSENT_STATUSES.has(status)) showDrafts(entry);
      };
      handle.subscribe(inspect);
      inspect();
    }
  };
  const stopClient = subscribeActiveMailClient(sync);
  const stopEntries = subscribe(sync);
  const stopLogout = subscribeMailEngineLogout(() => {
    sendingDrafts = NO_HIDDEN_DRAFTS;
    removeSession(SENDING_DRAFTS_STORAGE_KEY);
    notify();
  });
  sync();
  return () => {
    stopClient();
    stopEntries();
    stopLogout();
    for (const handle of watched.values()) handle.close();
    watched.clear();
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

function showDrafts(entry: SendingDrafts) {
  if (!sendingDrafts.includes(entry)) return;
  sendingDrafts = sendingDrafts.filter((item) => item !== entry);
  if (entry.operationId) storeSends();
  notify();
}

function storeSends() {
  const sends = sendingDrafts
    .filter((entry) => entry.operationId)
    .slice(-MAX_STORED_SENDS);
  try {
    if (sends.length)
      globalThis.sessionStorage?.setItem(
        SENDING_DRAFTS_STORAGE_KEY,
        JSON.stringify(sends),
      );
    else removeSession(SENDING_DRAFTS_STORAGE_KEY);
  } catch {
    // The drafts stay hidden on this page; they just won't be after a reload.
  }
}

function readStoredSends(): SendingDrafts[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(SENDING_DRAFTS_STORAGE_KEY);
    if (!raw) return NO_HIDDEN_DRAFTS;
    const stored: unknown = JSON.parse(raw);
    if (!Array.isArray(stored)) return NO_HIDDEN_DRAFTS;
    // One unreadable send leaves the others hidden.
    const sends = stored.flatMap((item) => {
      const parsed = storedSendSchema.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return sends.length ? sends : NO_HIDDEN_DRAFTS;
  } catch {
    return NO_HIDDEN_DRAFTS;
  }
}

function removeSession(key: string) {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {}
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

function upcomingScheduledEmailsKey(emailAccountId: string) {
  return [SCHEDULED_EMAILS_PATH, emailAccountId];
}
