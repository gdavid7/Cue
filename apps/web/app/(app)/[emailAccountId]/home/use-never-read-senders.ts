"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type {
  ConversationQuery,
  NeverReadSender,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { useUser } from "@/hooks/useUser";
import { createBrowserCache } from "@/utils/browser-cache";
import { isGetStartedWindowOpen } from "@/utils/get-started/checklist";
import type { TodayAccount } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

const WINDOW_MS = 30 * 86_400_000;
const NO_SENDERS: NeverReadSender[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

// Per user and account, cleared on sign-out and account removal. The card
// only shows in the first week, so a month outlasts every chance to show.
const hiddenSenders = createBrowserCache<true>({
  name: "never-read-hidden",
  ttlMs: WINDOW_MS,
  maxEntries: 200,
});

/**
 * Today's "Mail you never read": senders who mailed the inbox at least four
 * times in 30 days and were never opened, counted from this browser's local
 * mail with no model and no server. Only in the first week, like Get
 * started, and only once every account's first sync has finished, so read
 * state isn't half known. A sender hidden here stays hidden in this browser.
 */
export function useNeverReadSenders({
  accounts,
}: {
  accounts: TodayAccount[];
}): {
  senders: NeverReadSender[];
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
        receivedSinceMs: Date.now() - WINDOW_MS,
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
  const senders = useMemo(() => {
    if (!ready || !data) return NO_SENDERS;
    return data.filter(
      (sender) =>
        !hiddenHere.has(senderKey(sender)) &&
        !hiddenSenders.get(sender.accountId, sender.email),
    );
  }, [ready, data, hiddenHere]);

  const hide = useCallback((sender: NeverReadSender) => {
    hiddenSenders.set(sender.accountId, sender.email, true);
    setHiddenHere((current) => new Set(current).add(senderKey(sender)));
  }, []);

  return { senders, hide };
}

function senderKey(sender: NeverReadSender) {
  return `${sender.accountId}:${sender.email}`;
}
