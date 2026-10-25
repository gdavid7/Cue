"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import type {
  ConversationQuery,
  WaitingOnYouConversation,
} from "@inboxzero/mail-core/queries";
import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useMailboxWindow } from "@inboxzero/mail-react/use-mailbox-window";
import { createBrowserCache } from "@/utils/browser-cache";
import { isMetadataCoverageComplete } from "@/utils/mail-engine/coverage";
import type { TodayHomeData } from "@/utils/home/keep-shown-lanes";
import type { TodayAccount, TodayThread } from "@/utils/home/merge-home";
import { showCopiesOnce } from "@/utils/threads/cross-account-copies";
import { isLocalMailReady, localTodayThread } from "./use-local-inbox-rows";

const WAITING_ON_YOU_LIMIT = 5;
const WINDOW_MS = 14 * 86_400_000;
// A first sync stores the last few days whole before it backfills older mail
// (Gmail's first scan is three days of everything). Until the backfill ends,
// an older conversation may lack the reply the user sent, so only these days
// show, and older ones join below once the store holds them.
const SYNCING_WINDOW_MS = 3 * 86_400_000;
// Read past the five shown, so a few dismissals don't empty the group.
const READ_LIMIT = 25;
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_ORDER_BEFORE: {
  shown: readonly string[];
  held: ReadonlySet<string>;
} = { shown: [], held: new Set() };
const NO_SHOWN: {
  shown: WaitingOnYouConversation[];
  held: WaitingOnYouConversation[];
} = { shown: [], held: [] };
const NO_LABEL_IDS: string[] = [];

type DismissedConversation = {
  conversationId: string;
  messageId: string;
  /** The newest message's Message-ID, normalised or not. */
  messageKey?: string | null;
};

/** One account on Today, as Waiting on you decides whether to read it. */
type AccountTodayState = {
  /** The account's own Today, once it answers or from a saved copy. */
  home?: Pick<
    TodayHomeData,
    "cue" | "needsYou" | "pending" | "handledLabelIds"
  >;
  /** A lane stayed pending through every refresh. */
  gaveUp?: boolean;
  /** Whether Cue has read the mailbox, asked before its Today answers. */
  hasReadMail?: boolean;
  /** Its Today couldn't load, so its Needs reply isn't coming. */
  failed?: boolean;
};

// Per user and account, cleared on sign-out and account removal. A
// dismissal outlives the window its row could show in only as clutter.
const dismissals = createBrowserCache<true>({
  name: "waiting-on-you-dismissed",
  ttlMs: WINDOW_MS,
  maxEntries: 200,
});

/**
 * Today's Waiting on you: recent inbox conversations whose newest message is
 * from someone the user writes to, read from this browser's local mail with
 * no model, so a new mailbox has something to answer before Cue has read it.
 * Only the accounts in `handledLabelIds` are read, once their first sync,
 * and that of each account in `pendingAccountIds`, has finished. Rows keep their places as more mail syncs in: newer mail
 * joins on top, older below. A message delivered to several of them shows
 * once. Dismissing a row is kept in this browser only, until the
 * conversation gets a newer message.
 */
export function useWaitingOnYou({
  accounts,
  named,
  handledLabelIds,
  pendingAccountIds = NO_KEYS,
}: {
  /** Every account Today shows, which copies are named from. */
  accounts: TodayAccount[];
  /** Across accounts each row names its account. */
  named: boolean;
  /**
   * The accounts to read, each with the labels of mail Cue files there,
   * which is left to Cue. See `waitingOnYouScope`.
   */
  handledLabelIds: Record<string, string[]>;
  /**
   * Accounts whose Needs reply may still list a copy of a row's message. That
   * row waits for them, rather than showing and then moving to Needs reply.
   */
  pendingAccountIds?: ReadonlySet<string>;
}): { threads: TodayThread[]; dismiss: (thread: TodayThread) => void } {
  const client = useOptionalMailClient();
  const queryWaitingOnYou = client?.queryWaitingOnYou?.bind(client);
  const accountIds = useMemo(
    () => accounts.map((account) => account.id),
    [accounts],
  );
  const readAccounts = useMemo(
    () => accounts.filter((account) => account.id in handledLabelIds),
    [accounts, handledLabelIds],
  );
  const active = Boolean(queryWaitingOnYou) && readAccounts.length > 0;
  // The newest inbox and sent rows of every account, so an account joining
  // the read ones doesn't start the views over. The inbox's says whether the
  // store is ready. Each view republishes only when its rows, counts or
  // coverage change, so between them a new message or a reply the user
  // sent, here or elsewhere, reads the list again; a change deeper in the
  // inbox that moves neither waits for the next one.
  const inbox = useMailboxWindow(
    useMemo(() => newestIn(accountIds, "inbox"), [accountIds]),
    { client, enabled: active },
  );
  const sent = useMailboxWindow(
    useMemo(() => newestIn(accountIds, "sent"), [accountIds]),
    { client, enabled: active },
  );
  // An account whose Needs reply is still coming must have synced too, or
  // which rows it holds copies of isn't known yet.
  const waitedAccounts = useMemo(
    () =>
      accounts.filter(
        (account) =>
          account.id in handledLabelIds || pendingAccountIds.has(account.id),
      ),
    [accounts, handledLabelIds, pendingAccountIds],
  );
  const ready =
    active &&
    inbox.status === "ready" &&
    Boolean(inbox.data && isLocalMailReady(inbox.data, waitedAccounts));
  const syncing = !isMetadataCoverageComplete(
    (inbox.data?.coverage ?? []).filter(
      (item) => item.accountId in handledLabelIds,
    ),
  );

  const { data } = useSWR(
    ready && queryWaitingOnYou
      ? [
          "waiting-on-you",
          readAccounts.map((account) => account.id).join(","),
          JSON.stringify(handledLabelIds),
          inbox.revision?.databaseEpoch,
          inbox.revision?.sequence,
          sent.revision?.sequence,
          syncing,
        ]
      : null,
    () =>
      queryWaitingOnYou?.({
        accountIds: readAccounts.map((account) => account.id),
        ownAddresses: accounts.map((account) => account.email),
        receivedSinceMs: Date.now() - (syncing ? SYNCING_WINDOW_MS : WINDOW_MS),
        excludedLabelIds: handledLabelIds,
        limit: READ_LIMIT,
      }) ?? [],
    {
      keepPreviousData: true,
      revalidateOnFocus: false,
      // An older tab owning the engine, or the in-tab engine, can't answer.
      shouldRetryOnError: false,
    },
  );

  // The browser cache doesn't tell anyone when it changes, so what is
  // dismissed here is also kept here to update at once.
  const [dismissedHere, setDismissedHere] = useState(NO_KEYS);
  // What showed last, in order, which the next rows keep, and what was held
  // back then, which joins below them rather than on top when it shows.
  const [before, setBefore] = useState(NO_ORDER_BEFORE);
  const { shown, held } = useMemo(() => {
    if (!ready || !data) return NO_SHOWN;
    const candidates = data.filter(
      (conversation) =>
        // An earlier answer, kept while the next reads, may hold an account
        // no longer read.
        conversation.accountId in handledLabelIds &&
        !dismissedHere.has(
          `${conversation.accountId}:${dismissalKey(conversation)}`,
        ) &&
        !isWaitingOnYouDismissed(conversation.accountId, conversation),
    );
    const isHeld = (conversation: WaitingOnYouConversation) =>
      conversation.copyAccountIds.some((id) => pendingAccountIds.has(id));
    return {
      shown: keepShownOrder(
        before.shown,
        showCopiesOnce(
          candidates.filter((conversation) => !isHeld(conversation)),
          (conversation) => ({
            accountId: conversation.accountId,
            messageId: conversation.messageKey ?? undefined,
            at: conversation.receivedAtMs,
          }),
        ).map(({ row }) => row),
        WAITING_ON_YOU_LIMIT,
        before.held,
      ),
      held: candidates.filter(isHeld),
    };
  }, [ready, data, handledLabelIds, pendingAccountIds, dismissedHere, before]);
  // Kept for the next render as React stores what a render saw: set while
  // rendering, only when it changed, so this render's rows are the same.
  const shownKeys = shown.map(shownKey);
  const heldKeys = held.map(shownKey).filter((key) => !before.held.has(key));
  if (!sameKeys(shownKeys, before.shown) || heldKeys.length)
    setBefore({
      shown: shownKeys,
      held: new Set([...before.held, ...heldKeys]),
    });
  const threads = useMemo(() => {
    const byId = new Map(accounts.map((account) => [account.id, account]));
    return shown.flatMap((conversation) => {
      const account = byId.get(conversation.accountId);
      if (!account) return [];
      const row = localTodayThread({
        conversationId: conversation.conversationId,
        messageId: conversation.messageId,
        counterpart: conversation.from,
        subject: conversation.subject,
        preview: conversation.preview,
        atMs: conversation.receivedAtMs,
        unread: conversation.unread,
        starred: conversation.starred,
        rfcMessageId: conversation.messageKey,
      });
      if (!named) return [row];
      const alsoIn = conversation.copyAccountIds.flatMap(
        (id) => byId.get(id) ?? [],
      );
      return [{ ...row, account, ...(alsoIn.length ? { alsoIn } : {}) }];
    });
  }, [shown, accounts, named]);

  const dismiss = useCallback(
    (thread: TodayThread) => {
      const accountId = thread.account?.id ?? accounts[0]?.id;
      if (!accountId) return;
      const conversation = {
        conversationId: thread.threadId,
        messageId: thread.messageId,
        messageKey: thread.rfcMessageId,
      };
      // Every copy of the message goes, or another account's would show.
      const accountIds = [
        accountId,
        ...(thread.alsoIn ?? []).map((account) => account.id),
      ];
      for (const id of accountIds) dismissWaitingOnYou(id, conversation);
      setDismissedHere((current) => {
        const next = new Set(current);
        for (const id of accountIds)
          next.add(`${id}:${dismissalKey(conversation)}`);
        return next;
      });
    },
    [accounts],
  );

  return { threads, dismiss };
}

/**
 * What Waiting on you reads, from each account's state on Today. It reads
 * only a mailbox Cue hasn't read, whose Needs reply can only be empty: from
 * the account's Today once it answers, or before then from whether Cue has
 * read it. An account Cue has read, or isn't known to be new, waits for its
 * answer, which is Cue's. `pendingAccountIds` are those whose Needs reply
 * may still bring a conversation.
 */
export function waitingOnYouScope(
  accounts: { id: string }[],
  states: Record<string, AccountTodayState | undefined>,
): {
  handledLabelIds: Record<string, string[]>;
  pendingAccountIds: ReadonlySet<string>;
} {
  const handledLabelIds: Record<string, string[]> = {};
  const pendingAccountIds = new Set<string>();
  for (const { id } of accounts) {
    const { home, hasReadMail, failed } = states[id] ?? {};
    if (home) {
      if (!home.cue.hasReadMail && !home.needsYou.length)
        handledLabelIds[id] = home.handledLabelIds;
      // Past its last refresh, a lane still loading won't come.
      else if (home.pending.includes("needsYou") && !states[id]?.gaveUp)
        pendingAccountIds.add(id);
    } else if (hasReadMail === false) {
      // Cue has filed nothing in a mailbox it hasn't read.
      handledLabelIds[id] = NO_LABEL_IDS;
    } else if (!failed) {
      pendingAccountIds.add(id);
    }
  }
  return { handledLabelIds, pendingAccountIds };
}

/** Leaves the conversation out in this browser until a newer message. */
export function dismissWaitingOnYou(
  accountId: string,
  conversation: DismissedConversation,
) {
  dismissals.set(accountId, dismissalKey(conversation), true);
}

/** Whether this browser was asked to leave the conversation out. */
export function isWaitingOnYouDismissed(
  accountId: string,
  conversation: DismissedConversation,
) {
  return dismissals.get(accountId, dismissalKey(conversation)) === true;
}

/**
 * The newest of `conversations`, up to `limit`, with those already shown kept
 * in their order: one newer than all of them goes on top, as new mail does,
 * and any other goes below, as does one `late` names, so a row that syncs in
 * or is let through late never pushes the rows under it down.
 * `conversations` is newest first.
 */
export function keepShownOrder<
  T extends {
    accountId: string;
    conversationId: string;
    messageId: string;
    receivedAtMs: number;
  },
>(
  shownBefore: readonly string[],
  conversations: T[],
  limit: number,
  late: ReadonlySet<string> = NO_KEYS,
): T[] {
  const byKey = new Map(
    conversations.map((conversation) => [shownKey(conversation), conversation]),
  );
  const kept = shownBefore.flatMap((key) => byKey.get(key) ?? []);
  const keptKeys = new Set(kept.map(shownKey));
  const newestKeptMs = Math.max(
    ...kept.map((conversation) => conversation.receivedAtMs),
  );
  const added = conversations.filter(
    (conversation) => !keptKeys.has(shownKey(conversation)),
  );
  const onTop = (conversation: T) =>
    conversation.receivedAtMs > newestKeptMs &&
    !late.has(shownKey(conversation));
  return [
    ...added.filter(onTop),
    ...kept,
    ...added.filter((conversation) => !onTop(conversation)),
  ].slice(0, limit);
}

// A newer message makes it a new row, which goes where new mail does.
function shownKey(conversation: {
  accountId: string;
  conversationId: string;
  messageId: string;
}) {
  return `${conversation.accountId}:${conversation.conversationId}:${conversation.messageId}`;
}

function sameKeys(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((key, index) => key === b[index]);
}

// The newest message is part of it, so a later message brings it back. By
// its Message-ID when known, which is the same for its copy in another
// account, so dismissing one copy reads as dismissing each.
function dismissalKey(conversation: DismissedConversation) {
  return conversation.messageKey
    ? `message:${normalizeInternetMessageId(conversation.messageKey)}`
    : `${conversation.conversationId}:${conversation.messageId}`;
}

function newestIn(
  accountIds: string[],
  mailbox: "inbox" | "sent",
): ConversationQuery {
  return {
    accountIds,
    predicate: { kind: "mailbox", mailbox },
    order: "newest_first",
    pageSize: 1,
    after: null,
  };
}
