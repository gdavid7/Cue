"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type {
  ConversationQuery,
  MailboxView,
  NeverReadSender,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { useUser } from "@/hooks/useUser";
import { createBrowserCache } from "@/utils/browser-cache";
import { isGetStartedWindowOpen } from "@/utils/get-started/checklist";
import type { TodayAccount } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

/** How far back the card counts, and how long a hidden sender stays hidden. */
export const NEVER_READ_WINDOW_MS = 30 * 86_400_000;
const SHOWN_LIMIT = 5;
// Read past the five shown, so senders hidden here don't empty the card.
const READ_LIMIT = 25;
const NO_SENDERS: NeverReadSender[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

// Per user and account, cleared on sign-out and account removal. The card
// only shows in the first week, so the window outlasts every chance to show.
const hiddenSenders = createBrowserCache<true>({
  name: "never-read-hidden",
  ttlMs: NEVER_READ_WINDOW_MS,
  maxEntries: 200,
});

/**
 * Today's "Mail you never read": senders who mailed the inbox at least four
 * times in 30 days and were never opened, counted from this browser's local
 * mail with no model and no server. Only in the first week, like Get
 * started, and only once every account's first sync has finished, so read
 * state isn't half known. A sender hidden here stays hidden in this browser.
 * `sinceMs` is set when this browser holds less than the whole window.
 */
export function useNeverReadSenders({
  accounts,
}: {
  accounts: TodayAccount[];
}): {
  senders: NeverReadSender[];
  sinceMs: number | null;
  hide: (sender: NeverReadSender) => void;
} {
  const client = useOptionalMailClient();
  const { data: user } = useUser();
  const queryNeverReadSenders = client?.queryNeverReadSenders?.bind(client);
  const active =
    Boolean(user && isGetStartedWindowOpen(user, new Date())) &&
    Boolean(queryNeverReadSenders) &&
    accounts.length > 0;
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  // The newest inbox row: says whether the store is ready, and its revision
  // moves when new mail lands or read state changes, which reads again.
  const inbox = useMailboxWindow(
    useMemo<ConversationQuery>(
      () => ({
        accountIds,
        predicate: { kind: "mailbox", mailbox: "inbox" },
        order: "newest_first",
        pageSize: 1,
        after: null,
      }),
      [accountIds],
    ),
    { client, enabled: active },
  );
  const ready =
    active &&
    inbox.status === "ready" &&
    Boolean(inbox.data && isLocalMailReady(inbox.data, accounts));

  const { data } = useSWR(
    ready && queryNeverReadSenders
      ? [
          "never-read-senders",
          accountIds.join(","),
          inbox.revision?.databaseEpoch,
          inbox.revision?.sequence,
        ]
      : null,
    () =>
      queryNeverReadSenders?.({
        accountIds,
        ownAddresses: accounts.map((account) => account.email),
        receivedSinceMs: Date.now() - NEVER_READ_WINDOW_MS,
        limit: READ_LIMIT,
      }) ?? NO_SENDERS,
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // An older tab owning the engine answers "unsupported"; asking again
      // won't change that.
      shouldRetryOnError: false,
    },
  );

  // The browser cache doesn't say when it changes, so what is hidden here is
  // also kept here to update at once.
  const [hiddenHere, setHiddenHere] = useState(NO_KEYS);
  // The browser cache is keyed by the signed-in user, so another user's
  // hidden senders are read afresh.
  const userId = user?.id;
  const senders = useMemo(() => {
    if (!ready || !data || !userId) return NO_SENDERS;
    return data
      .filter(
        (sender) =>
          !hiddenHere.has(senderKey(sender)) &&
          !hiddenSenders.get(sender.accountId, sender.email),
      )
      .slice(0, SHOWN_LIMIT);
  }, [ready, data, hiddenHere, userId]);
  const sinceMs = useMemo(
    () => (inbox.data ? coveredSinceMs(inbox.data, accountIds) : null),
    [inbox.data, accountIds],
  );

  const hide = useCallback((sender: NeverReadSender) => {
    hiddenSenders.set(sender.accountId, sender.email, true);
    setHiddenHere((current) => new Set(current).add(senderKey(sender)));
  }, []);

  return { senders, sinceMs, hide };
}

/**
 * The latest point any account's mail here reaches back to, when that is
 * inside the window; null when every account covers the whole window.
 */
function coveredSinceMs(view: MailboxView, accountIds: string[]) {
  const windowStart = Date.now() - NEVER_READ_WINDOW_MS;
  const starts = view.coverage.flatMap((scope) =>
    accountIds.includes(scope.accountId) &&
    scope.windowStartMs !== undefined &&
    scope.windowStartMs > windowStart
      ? [scope.windowStartMs]
      : [],
  );
  return starts.length ? Math.max(...starts) : null;
}

function senderKey(sender: NeverReadSender) {
  return `${sender.accountId}:${sender.email}`;
}
