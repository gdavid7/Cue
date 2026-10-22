"use client";

import { useEffect, useMemo, useState } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  ConversationQuery,
  ConversationSummary,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { getFirstSyncAccountIds } from "@/utils/mail-engine/coverage";

// An engine without oldest_first is read newest first, a page at a time, up
// to the newest thousand unread; the oldest of those starts the batch.
const LEGACY_PAGE_SIZE = 100;
const LEGACY_MAX_PAGES = 10;

export type CatchUpRead =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; conversations: ConversationSummary[] };

/** The batch's conversations as the mailbox has them now. */
export type CatchUpWatch = {
  conversations: ConversationSummary[];
  /** Whether a batch conversation missing here has left the tab or been read. */
  complete: boolean;
};

/**
 * Reads Catch up's batch, then watches it. With `watched` null it reads the
 * tab's oldest unread conversations across `accountIds`, in one order; once
 * the batch is fixed it watches those conversations, each in its account.
 *
 * A desktop app built before `oldest_first` and the `conversation` predicate
 * refuses both as invalid, which reads as an errored snapshot. From then on
 * the same answers come from the queries it knows, so an old engine still
 * gets a batch, and a watch over the newest unread.
 */
export function useCatchUpMailbox({
  client,
  accountIds,
  tabPredicate,
  tabReady,
  batchRead,
  watched,
}: {
  client: MailClient | null;
  /** The accounts whose mail is read; none reads nothing. */
  accountIds: string[];
  tabPredicate: MailPredicate;
  tabReady: boolean;
  /** How many to read for the batch: a batch, plus any to skip. */
  batchRead: number;
  watched: Array<{ accountId: string; threadId: string }> | null;
}): { batch: CatchUpRead; watch: CatchUpWatch | null } {
  const [legacy, setLegacy] = useState(false);
  const watching = watched !== null;
  // Strings, so a new array with the same contents reads the same query.
  const accountKey = accountIds.join("\n");
  const watchKey =
    watched
      ?.map(({ accountId, threadId }) => `${accountId}\t${threadId}`)
      .join("\n") ?? "";

  const query = useMemo<ConversationQuery>(() => {
    const queried = accountKey ? accountKey.split("\n") : [];
    const unread: MailPredicate = {
      kind: "all",
      predicates: [tabPredicate, { kind: "read", value: false }],
    };
    if (legacy)
      return {
        accountIds: queried,
        predicate: unread,
        order: "newest_first",
        pageSize: LEGACY_PAGE_SIZE,
        after: null,
      };
    if (!watching)
      return {
        accountIds: queried,
        predicate: unread,
        order: "oldest_first",
        pageSize: batchRead,
        after: null,
      };
    return {
      accountIds: queried,
      predicate: {
        kind: "all",
        predicates: [unread, watchedPredicate(watchKey)],
      },
      order: "oldest_first",
      pageSize: Math.max(1, watchKey ? watchKey.split("\n").length : 1),
      after: null,
    };
  }, [legacy, watching, accountKey, tabPredicate, batchRead, watchKey]);

  const enabled = tabReady && Boolean(client) && accountIds.length > 0;
  const mailbox = useMailboxWindow(query, { client, enabled });
  const errored =
    enabled && (mailbox.status === "error" || mailbox.status === "unavailable");
  if (errored && !legacy) setLegacy(true);

  const view = enabled && mailbox.status === "ready" ? mailbox.data : null;
  const pages = view
    ? Math.ceil(view.conversations.length / LEGACY_PAGE_SIZE)
    : 0;
  // Only the batch read pages: the watch needs only the newest unread.
  const wantsMore =
    legacy && !watching && Boolean(view?.nextPage) && pages < LEGACY_MAX_PAGES;
  const { loadMore, isLoadingMore } = mailbox;
  useEffect(() => {
    if (wantsMore && !isLoadingMore) loadMore();
  }, [wantsMore, isLoadingMore, loadMore]);

  const synced =
    view && !getFirstSyncAccountIds(accountIds, view.coverage).length;

  let batch: CatchUpRead = { status: "loading" };
  if (errored && legacy) batch = { status: "unavailable" };
  else if (!watching && view && synced && !wantsMore && !isLoadingMore)
    batch = { status: "ready", conversations: view.conversations };

  const watch =
    watching && view
      ? {
          conversations: view.conversations,
          // The modern watch names every batch conversation; the newest
          // unread page covers them all only when nothing is past it.
          complete: !legacy || !view.nextPage,
        }
      : null;

  return { batch, watch };
}

/** The watched conversations, each matched within its own account. */
function watchedPredicate(watchKey: string): MailPredicate {
  const byAccount = new Map<string, string[]>();
  for (const entry of watchKey ? watchKey.split("\n") : []) {
    const [accountId, threadId] = entry.split("\t");
    byAccount.set(accountId, [...(byAccount.get(accountId) ?? []), threadId]);
  }
  const predicates: MailPredicate[] = [...byAccount].map(
    ([accountId, ids]) => ({ kind: "conversation", ids, accountId }),
  );
  if (predicates.length === 1) return predicates[0];
  // A batch is ten cards, so never past the engine's 32 children.
  return predicates.length
    ? { kind: "any", predicates }
    : { kind: "conversation", ids: [] };
}
