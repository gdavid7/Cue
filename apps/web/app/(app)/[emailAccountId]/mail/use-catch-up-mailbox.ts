"use client";

import { useEffect, useMemo, useState } from "react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type {
  ConversationQuery,
  ConversationSummary,
  MailboxView,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import type {
  CatchUpCopiesFound,
  CatchUpItem,
} from "@/app/(app)/[emailAccountId]/mail/catch-up-queue";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { getFirstSyncAccountIds } from "@/utils/mail-engine/coverage";

// An engine without oldest_first is read newest first, a page at a time, up
// to the newest thousand unread; the oldest of those starts the batch.
const LEGACY_PAGE_SIZE = 100;
const LEGACY_MAX_PAGES = 10;
// A message delivered to several of the user's addresses reaches each within
// moments; an hour either side of a card's message finds its copies.
const COPY_WINDOW_MS = 60 * 60 * 1000;
// One sender's mail in two hours is a page; past five, the read gives up and
// says so rather than guess.
const COPY_PAGE_SIZE = 50;
const COPY_MAX_PAGES = 5;
// A page the engine never answers counts as a failed read.
const COPY_PAGE_TIMEOUT_MS = 15_000;

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

export type CatchUpCopiesRead =
  | { status: "loading" }
  | { status: "ready"; found: ReadonlyMap<string, CatchUpCopiesFound> };

/**
 * Reads, for each card with a Message-ID, every conversation in the included
 * accounts from its sender within an hour of its message, read or not, page
 * by page to the end, so its copies can be found even where the batch's
 * unread read didn't reach them. A read that fails, or doesn't reach the end
 * within a few pages, says so as incomplete rather than guessing. The order
 * and predicates are ones an engine from before Catch up knows.
 */
export function useCatchUpCopies({
  client,
  accountIds,
  cards,
}: {
  client: MailClient | null;
  accountIds: string[];
  /** The cards to read for; null until they are known. */
  cards: CatchUpItem[] | null;
}): CatchUpCopiesRead {
  const reads = useMemo(
    () =>
      (cards ?? []).flatMap((card) =>
        card.messageKey
          ? [{ key: card.key, from: card.fromAddress, atMs: card.atMs }]
          : [],
      ),
    [cards],
  );
  const readKey = JSON.stringify([accountIds, reads]);
  const [answer, setAnswer] = useState<{
    readKey: string;
    found: ReadonlyMap<string, CatchUpCopiesFound>;
  } | null>(null);

  // readKey stands for accountIds and reads, which are rebuilt each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client || !reads.length) return;
    let cancelled = false;
    Promise.all(
      reads.map(
        async (read) =>
          [read.key, await readCopies(client, accountIds, read)] as const,
      ),
    ).then((entries) => {
      if (!cancelled) setAnswer({ readKey, found: new Map(entries) });
    });
    return () => {
      cancelled = true;
    };
  }, [client, readKey]);

  if (cards === null) return { status: "loading" };
  if (!reads.length) return { status: "ready", found: NO_COPIES_FOUND };
  // Without an engine nothing can be read, and nothing acted on either.
  if (!client) return { status: "loading" };
  return answer?.readKey === readKey
    ? { status: "ready", found: answer.found }
    : { status: "loading" };
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

const NO_COPIES_FOUND: ReadonlyMap<string, CatchUpCopiesFound> = new Map();

async function readCopies(
  client: MailClient,
  accountIds: string[],
  card: { from: string; atMs: number },
): Promise<CatchUpCopiesFound> {
  if (!card.from || !accountIds.length)
    return { conversations: [], complete: false };
  const conversations: ConversationSummary[] = [];
  let after: string | null = null;
  for (let page = 0; page < COPY_MAX_PAGES; page++) {
    const view = await readMailboxPage(client, {
      accountIds,
      predicate: {
        kind: "all",
        predicates: [
          {
            kind: "received",
            afterMs: card.atMs - COPY_WINDOW_MS,
            beforeMs: card.atMs + COPY_WINDOW_MS,
          },
          {
            kind: "address",
            field: "from",
            value: card.from,
            match: "address",
          },
        ],
      },
      order: "newest_first",
      pageSize: COPY_PAGE_SIZE,
      after,
    });
    if (!view) return { conversations, complete: false };
    conversations.push(...view.conversations);
    if (!view.nextPage) return { conversations, complete: true };
    after = view.nextPage;
  }
  return { conversations, complete: false };
}

/** One page of a mailbox query, or null when the engine can't answer it. */
function readMailboxPage(
  client: MailClient,
  query: ConversationQuery,
): Promise<MailboxView | null> {
  return new Promise((resolve) => {
    let handle: ReturnType<MailClient["observeMailbox"]>;
    try {
      handle = client.observeMailbox(query);
    } catch {
      resolve(null);
      return;
    }
    let unsubscribe = () => {};
    const finish = (view: MailboxView | null) => {
      clearTimeout(timer);
      unsubscribe();
      handle.close();
      resolve(view);
    };
    const timer = setTimeout(() => finish(null), COPY_PAGE_TIMEOUT_MS);
    const check = () => {
      const snapshot = handle.getSnapshot();
      if (snapshot.status === "loading") return;
      finish(snapshot.status === "ready" ? snapshot.data : null);
    };
    unsubscribe = handle.subscribe(check);
    check();
  });
}
