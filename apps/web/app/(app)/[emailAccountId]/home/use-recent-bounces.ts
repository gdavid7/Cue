"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";
import type {
  ConversationQuery,
  RecentBounce,
} from "@inboxzero/mail-core/queries";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { useUser } from "@/hooks/useUser";
import { createBrowserCache } from "@/utils/browser-cache";
import type { TodayAccount } from "@/utils/home/merge-home";
import { isLocalMailReady } from "./use-local-inbox-rows";

/** How far back a bounce shows, and how long a dismissed one stays hidden. */
export const BOUNCE_WINDOW_MS = 7 * 86_400_000;
const SHOWN_LIMIT = 3;
// Read past the three shown, so dismissed ones don't empty the cards.
const READ_LIMIT = 20;
const NO_BOUNCES: RecentBounce[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();

/** A bounce as Today's "Didn't send" card shows it. */
export type TodayBounce = RecentBounce & {
  /** What the user sent, when the bounce is in its conversation; else its own subject. */
  title: string;
};

// Per user and account, cleared on sign-out and account removal. IDs only.
const dismissals = createBrowserCache<true>({
  name: "bounce-dismissed",
  ttlMs: BOUNCE_WINDOW_MS,
  maxEntries: 200,
});

/**
 * Today's "Didn't send": inbox mail from the last week saying a message
 * didn't reach someone, read from this browser's local mail with no model
 * and no server. Once every account's first sync has finished, so a bounce
 * isn't shown and then found to have been answered by a later send. A
 * dismissed bounce stays hidden in this browser until a newer one arrives
 * in its conversation.
 */
export function useRecentBounces({ accounts }: { accounts: TodayAccount[] }): {
  bounces: TodayBounce[];
  dismiss: (bounce: TodayBounce) => void;
} {
  const client = useOptionalMailClient();
  const { data: user } = useUser();
  // A tab relaying an older engine may not answer it.
  const queryRecentBounces = mailClientSupports(
    client,
    "method:queryRecentBounces",
  )
    ? client?.queryRecentBounces?.bind(client)
    : undefined;
  const active = Boolean(queryRecentBounces) && accounts.length > 0;
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  // The newest inbox row: says whether the store is ready, and its revision
  // moves when mail lands or leaves the inbox, which reads again.
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
    ready && queryRecentBounces
      ? [
          "recent-bounces",
          accountIds.join(","),
          inbox.revision?.databaseEpoch,
          inbox.revision?.sequence,
        ]
      : null,
    () =>
      queryRecentBounces?.({
        accountIds,
        receivedSinceMs: Date.now() - BOUNCE_WINDOW_MS,
        limit: READ_LIMIT,
      }) ?? NO_BOUNCES,
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // An older tab owning the engine answers "unsupported"; asking again
      // won't change that.
      shouldRetryOnError: false,
    },
  );

  // The browser cache doesn't say when it changes, so what is dismissed here
  // is also kept here to update at once.
  const [dismissedHere, setDismissedHere] = useState(NO_KEYS);
  // The browser cache is keyed by the signed-in user, so another user's
  // dismissals are read afresh.
  const userId = user?.id;
  const recent = ready && data ? data : NO_BOUNCES;
  const bounces = useMemo(() => {
    if (!userId) return [];
    return recent
      .filter(
        (bounce) =>
          !dismissedHere.has(dismissalKey(bounce)) &&
          !dismissals.get(bounce.accountId, dismissalKey(bounce)),
      )
      .slice(0, SHOWN_LIMIT)
      .map((bounce) => ({
        ...bounce,
        title: shownSubject(bounce.sentSubject ?? bounce.subject),
      }));
  }, [recent, dismissedHere, userId]);
  const dismiss = useCallback((bounce: TodayBounce) => {
    dismissals.set(bounce.accountId, dismissalKey(bounce), true);
    setDismissedHere((current) => new Set(current).add(dismissalKey(bounce)));
  }, []);

  return { bounces, dismiss };
}

// By its newest bounce, so another bounce in the conversation shows again.
function dismissalKey(bounce: RecentBounce) {
  return `${bounce.accountId}\0${bounce.conversationId}\0${bounce.messageId}`;
}

function shownSubject(subject: string) {
  return subject.replace(/^((re|fwd?):\s*)+/i, "").trim() || "(no subject)";
}
