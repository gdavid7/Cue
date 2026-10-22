import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { getListThreadKey } from "@/app/(app)/[emailAccountId]/mail/types";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import { decodeSnippet } from "@/utils/gmail/decode";
import { showCopiesOnce } from "@/utils/threads/cross-account-copies";

export const CATCH_UP_BATCH_SIZE = 10;

export type CatchUpAction = "archive" | "keep" | "snooze";

export type CatchUpItem = {
  /** The list's key for the conversation, which thread actions take. */
  key: string;
  threadId: string;
  accountId: string;
  latestMessageId: string;
  /** The same message in other accounts, which archive and read reach too. */
  copies: Array<{ accountId: string; threadId: string }>;
  sender: string;
  subject: string;
  preview: string;
  atMs: number;
};

/** How the view keys and names the conversations Catch up shows. */
export type CatchUpScope = {
  /** The user's own address in an account, to name who mail is with. */
  ownEmail: (accountId: string) => string;
  /**
   * All inboxes, where a row's key carries its account and a message in
   * several accounts is one row, shown from the routed account where it can
   * be, as the list shows it.
   */
  combined: { routedAccountId: string } | null;
};

/**
 * The batch's conversations still unread in the tab, as the mailbox has them
 * now. `complete` says whether one missing here has left the tab or been
 * read, or may only be past what was read.
 */
export type CatchUpLive = {
  items: ReadonlyMap<string, CatchUpItem>;
  complete: boolean;
};

/**
 * One batch, fixed when it starts so the card never reshuffles as the
 * mailbox catches up behind it. `history` is the order actions were taken.
 */
export type CatchUpState = {
  items: CatchUpItem[];
  acted: Record<string, CatchUpAction>;
  history: string[];
  /** Read, or gone from the tab, elsewhere since the batch started. */
  skipped: Record<string, true>;
  /** Brought back by an undo, which the mailbox may not show yet. */
  returned: Record<string, true>;
  /**
   * Accounts whose open cards wait for another batch, as their mail couldn't
   * be reached or changed, so the other accounts' cards carry on.
   */
  setAside: Record<string, true>;
};

export function toCatchUpItem(
  conversation: ConversationSummary,
  scope: CatchUpScope,
  copies: ConversationSummary[] = [],
): CatchUpItem | null {
  // A conversation that is only a draft has nothing to read yet.
  if (!conversation.latestMessageId) return null;
  const { accountId, conversationId } = conversation.key;
  const own = scope.ownEmail(accountId).toLowerCase();
  // Who it's with: the latest sender who isn't the user, as Today names it.
  const from =
    conversation.senders.findLast(
      (sender) => extractEmailAddress(sender).toLowerCase() !== own,
    ) || conversation.from;
  return {
    key: getListThreadKey({
      id: conversationId,
      account: scope.combined ? { id: accountId } : undefined,
    }),
    threadId: conversationId,
    accountId,
    latestMessageId: conversation.latestMessageId,
    copies: copies.map((copy) => ({
      accountId: copy.key.accountId,
      threadId: copy.key.conversationId,
    })),
    sender: extractNameFromEmail(from) || extractEmailAddress(from),
    subject: conversation.subject,
    preview: decodeSnippet(conversation.preview),
    atMs: conversation.latestMessageAtMs,
  };
}

/**
 * The unread conversations in a mailbox view, as the card shows them. In All
 * inboxes a message in several accounts is one card, unread while any copy
 * is, as it is one row in the list.
 */
export function toCatchUpItems(
  conversations: ConversationSummary[],
  scope: CatchUpScope,
): CatchUpItem[] {
  const shown = scope.combined
    ? showCopiesOnce(
        conversations,
        (conversation) => ({
          accountId: conversation.key.accountId,
          messageId: conversation.latestInternetMessageId,
          at: conversation.latestMessageAtMs,
        }),
        scope.combined.routedAccountId,
      )
    : conversations.map((row) => ({ row, copies: [] }));
  return shown.flatMap(({ row, copies }) => {
    if (!row.unread && !copies.some((copy) => copy.unread)) return [];
    const item = toCatchUpItem(row, scope, copies);
    return item ? [item] : [];
  });
}

/** The oldest conversations first, up to a batch, past any already acted on. */
export function startCatchUp(
  items: CatchUpItem[],
  skip?: ReadonlySet<string>,
): CatchUpState {
  return {
    items: items
      .filter((item) => !skip?.has(item.key))
      .sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key))
      .slice(0, CATCH_UP_BATCH_SIZE),
    acted: {},
    history: [],
    skipped: {},
    returned: {},
    setAside: {},
  };
}

export function currentCatchUpItem(state: CatchUpState): CatchUpItem | null {
  return state.items.find((item) => isOpen(state, item)) ?? null;
}

export function catchUpLeft(state: CatchUpState) {
  return state.items.filter((item) => isOpen(state, item)).length;
}

/**
 * Sets aside the open cards of accounts whose mail can't be reached or
 * changed, so one account's trouble never holds up another's cards. Cards
 * already acted on keep their undo. Returns the same state when nothing
 * changed.
 */
export function setAsideCatchUpAccounts(
  state: CatchUpState,
  accountIds: readonly string[],
): CatchUpState {
  const added = accountIds.filter(
    (accountId) =>
      !state.setAside[accountId] &&
      state.items.some((item) => item.accountId === accountId),
  );
  if (!added.length) return state;
  return {
    ...state,
    setAside: {
      ...state.setAside,
      ...Object.fromEntries(added.map((accountId) => [accountId, true])),
    },
  };
}

export function actOnCatchUp(
  state: CatchUpState,
  key: string,
  action: CatchUpAction,
): CatchUpState {
  if (!state.items.some((item) => item.key === key && isOpen(state, item)))
    return state;
  const { [key]: _returned, ...returned } = state.returned;
  return {
    ...state,
    acted: { ...state.acted, [key]: action },
    history: [...state.history, key],
    returned,
  };
}

/**
 * Takes back the action on `key`, wherever it sits in the history, as an
 * undo or a refused command does. Batches are worked oldest first, so the
 * conversation is the current one again unless an older one is still open.
 */
export function revertCatchUp(state: CatchUpState, key: string): CatchUpState {
  if (!state.acted[key]) return state;
  const { [key]: _acted, ...acted } = state.acted;
  return {
    ...state,
    acted,
    history: state.history.filter((entry) => entry !== key),
    returned: { ...state.returned, [key]: true },
  };
}

/**
 * Brings open cards up to date with the mailbox: a conversation read or gone
 * from the tab elsewhere is skipped, and one with a newer message shows it.
 * Returns the same state when nothing changed.
 */
export function reconcileCatchUp(
  state: CatchUpState,
  live: CatchUpLive | null,
): CatchUpState {
  if (!live) return state;
  let next = state;
  for (const item of state.items) {
    if (state.acted[item.key] || state.skipped[item.key]) continue;
    const now = live.items.get(item.key);
    if (state.returned[item.key]) {
      // Back in the mailbox after an undo: from here on it is watched again.
      if (now) next = withoutReturned(next, item.key);
      continue;
    }
    if (!now) {
      if (live.complete)
        next = { ...next, skipped: { ...next.skipped, [item.key]: true } };
      continue;
    }
    if (!sameCard(item, now)) {
      next = {
        ...next,
        // The watch reads the card's own conversation, not the copies
        // found with it when the batch started.
        items: next.items.map((entry) =>
          entry.key === item.key ? { ...now, copies: item.copies } : entry,
        ),
      };
    }
  }
  return next;
}

function isOpen(state: CatchUpState, item: CatchUpItem) {
  return (
    !state.acted[item.key] &&
    !state.skipped[item.key] &&
    !state.setAside[item.accountId]
  );
}

function withoutReturned(state: CatchUpState, key: string): CatchUpState {
  const { [key]: _returned, ...returned } = state.returned;
  return { ...state, returned };
}

function sameCard(a: CatchUpItem, b: CatchUpItem) {
  return (
    a.latestMessageId === b.latestMessageId &&
    a.atMs === b.atMs &&
    a.subject === b.subject &&
    a.preview === b.preview &&
    a.sender === b.sender
  );
}
