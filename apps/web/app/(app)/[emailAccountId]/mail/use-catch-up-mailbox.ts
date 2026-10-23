"use client";

import { useEffect, useMemo, useState } from "react";
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";
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
// A batch's copies are a few per card; past this many pages the read gives
// up and says so rather than guess.
const COPY_PAGE_SIZE = 100;
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
  const [refused, setRefused] = useState(false);
  // An engine that reports what it can do says up front whether it orders
  // oldest first; one from before reporting is found out by its refusal.
  const legacy =
    refused ||
    (Boolean(client?.capabilities) &&
      !mailClientSupports(client, "order:oldest_first"));
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
  if (errored && !legacy) setRefused(true);

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
 * Reads every conversation in the included accounts holding one of the cards'
 * Message-IDs, read or not, in one query, page by page to the end, so a
 * card's copies are found even where the batch's unread read didn't reach
 * them. Each card hears what was found and whether the read reached every
 * one: a read that fails, is cancelled or doesn't end within its pages says
 * so, rather than guess. A read that fails is tried again once; one that
 * runs past its pages is read card by card, so one noisy Message-ID can't
 * leave the whole batch out.
 *
 * It sees only what each account's local store holds: a copy older than an
 * account's synced window isn't there to find, or to change, until that
 * account syncs further back. The caller checks the engine can match a
 * Message-ID (`predicate:internet_message_id`) before asking.
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
  const keyed = useMemo(
    () =>
      (cards ?? []).flatMap((card) =>
        card.messageKey ? [{ key: card.key, messageKey: card.messageKey }] : [],
      ),
    [cards],
  );
  const readKey = JSON.stringify([accountIds, keyed]);
  const [answer, setAnswer] = useState<{
    readKey: string;
    found: ReadonlyMap<string, CatchUpCopiesFound>;
  } | null>(null);

  // readKey stands for accountIds and keyed, which are rebuilt each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!client || !keyed.length) return;
    const signal = { cancelled: false };
    readEveryCardsCopies(client, accountIds, keyed, signal).then((found) => {
      if (!signal.cancelled) setAnswer({ readKey, found });
    });
    return () => {
      signal.cancelled = true;
    };
  }, [client, readKey]);

  if (cards === null) return { status: "loading" };
  if (!keyed.length) return { status: "ready", found: NO_COPIES_FOUND };
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

async function readEveryCardsCopies(
  client: MailClient,
  accountIds: string[],
  cards: Array<{ key: string; messageKey: string }>,
  signal: { cancelled: boolean },
): Promise<ReadonlyMap<string, CatchUpCopiesFound>> {
  const read = (messageKeys: string[]) =>
    readCopiesTwice(client, accountIds, messageKeys, signal);
  const shared = await read(cards.map((card) => card.messageKey));
  // Only a read that ran past its pages is worth splitting; one the engine
  // couldn't answer twice won't answer card by card either.
  if (shared.outcome !== "overflow")
    return new Map(
      cards.map((card) => [
        card.key,
        {
          conversations: shared.conversations,
          complete: shared.outcome === "complete",
        },
      ]),
    );
  const found = new Map<string, CatchUpCopiesFound>();
  for (const card of cards) {
    if (signal.cancelled) return found;
    const own = await read([card.messageKey]);
    found.set(card.key, {
      conversations: own.conversations,
      complete: own.outcome === "complete",
    });
  }
  return found;
}

/** A read, tried again once if it failed rather than ran past its pages. */
async function readCopiesTwice(
  client: MailClient,
  accountIds: string[],
  messageKeys: string[],
  signal: { cancelled: boolean },
) {
  const first = await readCopies(client, accountIds, messageKeys, signal);
  if (first.outcome !== "failed" || signal.cancelled) return first;
  return readCopies(client, accountIds, messageKeys, signal);
}

async function readCopies(
  client: MailClient,
  accountIds: string[],
  messageKeys: string[],
  signal: { cancelled: boolean },
): Promise<{
  conversations: ConversationSummary[];
  outcome: "complete" | "overflow" | "failed";
}> {
  const conversations: ConversationSummary[] = [];
  if (!accountIds.length) return { conversations, outcome: "failed" };
  let after: string | null = null;
  for (let page = 0; page < COPY_MAX_PAGES; page++) {
    if (signal.cancelled) return { conversations, outcome: "failed" };
    const view = await readMailboxPage(client, {
      accountIds,
      predicate: { kind: "internet_message_id", ids: messageKeys },
      order: "newest_first",
      pageSize: COPY_PAGE_SIZE,
      after,
    });
    if (!view) return { conversations, outcome: "failed" };
    conversations.push(...view.conversations);
    if (!view.nextPage) return { conversations, outcome: "complete" };
    after = view.nextPage;
  }
  return { conversations, outcome: "overflow" };
}

/**
 * One page of a mailbox query, or null when the engine can't answer it: an
 * error, a rejection, or no answer in time. It settles once, whichever
 * comes first.
 */
function readMailboxPage(
  client: MailClient,
  query: ConversationQuery,
): Promise<MailboxView | null> {
  return new Promise((resolve) => {
    let settled = false;
    let handle: ReturnType<MailClient["observeMailbox"]> | undefined;
    let unsubscribe = () => {};
    const finish = (view: MailboxView | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        unsubscribe();
        handle?.close();
      } catch {
        // Closing a handle the engine already dropped changes nothing.
      }
      resolve(view);
    };
    const timer = setTimeout(() => finish(null), COPY_PAGE_TIMEOUT_MS);
    const check = () => {
      const snapshot = handle?.getSnapshot();
      if (!snapshot || snapshot.status === "loading") return;
      finish(snapshot.status === "ready" ? snapshot.data : null);
    };
    try {
      handle = client.observeMailbox(query);
      unsubscribe = handle.subscribe(check);
      check();
    } catch {
      finish(null);
    }
  });
}
