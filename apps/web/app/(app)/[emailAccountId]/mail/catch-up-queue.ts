import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { getListThreadKey } from "@/app/(app)/[emailAccountId]/mail/types";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import { decodeSnippet } from "@/utils/gmail/decode";
import { showCopiesOnce } from "@/utils/threads/cross-account-copies";

export const CATCH_UP_BATCH_SIZE = 10;

export type CatchUpAction = "archive" | "keep" | "snooze";

/** The same message in another account, which every card action reaches. */
export type CatchUpCopy = {
  accountId: string;
  threadId: string;
  /** Whether it is in its own inbox, so an undo puts it back where it was. */
  inInbox: boolean;
  /** Whether it was unread when the card was made, so undoing Keep restores only that. */
  unread: boolean;
};

export type CatchUpItem = {
  /** The list's key for the conversation, which thread actions take. */
  key: string;
  threadId: string;
  accountId: string;
  latestMessageId: string;
  /**
   * The conversation's key, as the engine gives it: its latest message's
   * Message-ID (not a draft or in the trash; sent counts), normalised. Its
   * copies in other accounts share it.
   */
  messageKey: string | null;
  /** Whether the conversation is in its inbox. */
  inInbox: boolean;
  /** Whether it was unread when the card was made; a copy may be the unread one. */
  unread: boolean;
  copies: CatchUpCopy[];
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
   * several accounts is one card, shown from the routed account whenever it
   * has a copy, so the card is the routed account's conversation, as Reply
   * opens it.
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

/** Why an account's open cards were set aside. */
export type CatchUpSetAside = "unreachable" | "refused";

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
  setAside: Record<string, CatchUpSetAside>;
  /**
   * Cards left out because their copies couldn't all be found for sure, so
   * acting on them could leave one copy behind.
   */
  incomplete: string[];
};

/**
 * What a card's read for copies found: every conversation in the included
 * accounts that could be a copy, and whether that read reached all of them.
 */
export type CatchUpCopiesFound = {
  conversations: ConversationSummary[];
  complete: boolean;
};

export function toCatchUpItem(
  conversation: ConversationSummary,
  scope: CatchUpScope,
  copies: CatchUpCopy[] = [],
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
    messageKey: conversation.latestInternetMessageId ?? null,
    inInbox: conversation.roles.includes("inbox"),
    unread: conversation.unread,
    copies,
    sender: extractNameFromEmail(from) || extractEmailAddress(from),
    subject: conversation.subject,
    preview: decodeSnippet(conversation.preview),
    atMs: conversation.latestMessageAtMs,
  };
}

/**
 * The unread conversations in a mailbox view, as the card shows them. In All
 * inboxes a message in several accounts is one card, unread while any copy
 * is, shown from the routed account whenever it has a copy, as Reply opens
 * it there. The grouping runs over everything read, before a batch is cut.
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
        { alwaysPrefer: true },
      )
    : conversations.map((row) => ({ row, copies: [] }));
  return shown.flatMap(({ row, copies }) => {
    if (!row.unread && !copies.some((copy) => copy.unread)) return [];
    const item = toCatchUpItem(row, scope, copies.map(toCopy));
    return item ? [item] : [];
  });
}

/**
 * Completes each card's copies from the read for them, which isn't limited to
 * unread mail or to the page the batch came from: archive, read and snooze
 * must reach every copy. Copies follow the conversation key, the Message-ID
 * of a conversation's latest message that isn't a draft or in the trash
 * (sent mail counts), the rule showCopiesOnce groups the list by: where the
 * user replied in one account, that conversation's key moved on, and it is a
 * conversation of its own rather than a copy. Copies in the trash or spam
 * are left alone. A card is left out of the batch, its key added to
 * `incomplete`, when that read didn't reach every possible copy, when some
 * account (its own included) has a second conversation for its message, or
 * when it would become a card acted on already or in the batch twice, as
 * acting on it could leave a copy behind. The card becomes the routed
 * account's conversation only where that one is in its inbox; otherwise the
 * routed one is just a copy.
 */
export function withCatchUpCopies(
  state: CatchUpState,
  found: ReadonlyMap<string, CatchUpCopiesFound>,
  scope: CatchUpScope,
  skip?: ReadonlySet<string>,
): CatchUpState {
  if (!scope.combined) return state;
  const routedAccountId = scope.combined.routedAccountId;
  const incomplete: string[] = [];
  const items: CatchUpItem[] = [];
  for (const item of state.items) {
    const read = found.get(item.key);
    // No read means no Message-ID: there is nothing a copy could match.
    if (!read) {
      items.push(item);
      continue;
    }
    const perAccount = new Map<string, ConversationSummary[]>();
    for (const match of read.conversations) {
      // The read may hold other cards' keys too.
      if (match.latestInternetMessageId !== item.messageKey) continue;
      // Deleted or junk mail is no copy to act on, nor a second conversation.
      if (match.roles.includes("trash") || match.roles.includes("spam"))
        continue;
      const own =
        match.key.accountId === item.accountId &&
        match.key.conversationId === item.threadId;
      if (own) continue;
      perAccount.set(match.key.accountId, [
        ...(perAccount.get(match.key.accountId) ?? []),
        match,
      ]);
    }
    const ambiguous =
      perAccount.has(item.accountId) ||
      [...perAccount.values()].some(
        (matches) =>
          new Set(matches.map((match) => match.key.conversationId)).size > 1,
      );
    if (!read.complete || ambiguous) {
      incomplete.push(item.key);
      continue;
    }
    const copies = new Map(item.copies.map((copy) => [copy.accountId, copy]));
    for (const [accountId, [match]] of perAccount)
      if (!copies.has(accountId)) copies.set(accountId, toCopy(match));
    const routed = perAccount.get(routedAccountId)?.[0];
    const swaps =
      routed &&
      item.accountId !== routedAccountId &&
      routed.roles.includes("inbox");
    if (!swaps) {
      items.push({ ...item, copies: [...copies.values()] });
      continue;
    }
    // The routed account has it in its inbox too: the card is its copy.
    copies.delete(routedAccountId);
    const swapped = toCatchUpItem(routed, scope, [
      ...copies.values(),
      {
        accountId: item.accountId,
        threadId: item.threadId,
        inInbox: item.inInbox,
        unread: item.unread,
      },
    ]);
    if (
      !swapped ||
      skip?.has(swapped.key) ||
      items.some((entry) => entry.key === swapped.key)
    ) {
      incomplete.push(item.key);
      continue;
    }
    items.push(swapped);
  }
  return { ...state, items, incomplete: [...state.incomplete, ...incomplete] };
}

/** Conversations the card stands for that were unread when it was made. */
export function catchUpUnreadConversations(item: CatchUpItem) {
  return [
    ...(item.unread
      ? [{ accountId: item.accountId, threadId: item.threadId }]
      : []),
    ...item.copies
      .filter((copy) => copy.unread)
      .map(({ accountId, threadId }) => ({ accountId, threadId })),
  ];
}

/**
 * The batch's cards as the watch has them now. A card stays while its own
 * conversation or any copy is still unread in the tab, as the list's row
 * does, and shows its own conversation's newest message when that is here.
 */
export function toCatchUpLive(
  state: CatchUpState,
  conversations: ConversationSummary[],
  scope: CatchUpScope,
  complete: boolean,
): CatchUpLive {
  const cardOf = new Map<string, CatchUpItem>();
  for (const item of state.items) {
    cardOf.set(`${item.accountId}\t${item.threadId}`, item);
    for (const copy of item.copies)
      cardOf.set(`${copy.accountId}\t${copy.threadId}`, item);
  }
  const items = new Map<string, CatchUpItem>();
  for (const conversation of conversations) {
    const card = cardOf.get(
      `${conversation.key.accountId}\t${conversation.key.conversationId}`,
    );
    if (!card) continue;
    const own =
      conversation.key.accountId === card.accountId &&
      conversation.key.conversationId === card.threadId;
    if (!own) {
      if (!items.has(card.key)) items.set(card.key, card);
      continue;
    }
    const item = toCatchUpItem(conversation, scope, card.copies);
    if (item) items.set(card.key, item);
  }
  return { items, complete };
}

/** Every conversation a batch's cards stand for, each in its own account. */
export function catchUpConversations(state: CatchUpState) {
  return state.items.flatMap((item) => [
    { accountId: item.accountId, threadId: item.threadId },
    ...item.copies.map(({ accountId, threadId }) => ({ accountId, threadId })),
  ]);
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
    incomplete: [],
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
 * already acted on keep their undo. The first reason given for an account
 * stays. Returns the same state when nothing changed.
 */
export function setAsideCatchUpAccounts(
  state: CatchUpState,
  accountIds: readonly string[],
  reason: CatchUpSetAside,
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
      ...Object.fromEntries(added.map((accountId) => [accountId, reason])),
    },
  };
}

/**
 * Drops what an account no longer in the view holds: its cards, and its
 * copies behind other cards. Returns the same state when nothing changed.
 */
export function keepCatchUpAccounts(
  state: CatchUpState,
  accountIds: readonly string[],
): CatchUpState {
  const kept = new Set(accountIds);
  const holds = (accountId: string) => kept.has(accountId);
  const unchanged = state.items.every(
    (item) =>
      holds(item.accountId) &&
      item.copies.every((copy) => holds(copy.accountId)),
  );
  if (unchanged) return state;
  return {
    ...state,
    items: state.items
      .filter((item) => holds(item.accountId))
      .map((item) =>
        item.copies.every((copy) => holds(copy.accountId))
          ? item
          : {
              ...item,
              copies: item.copies.filter((copy) => holds(copy.accountId)),
            },
      ),
    setAside: Object.fromEntries(
      Object.entries(state.setAside).filter(([accountId]) => holds(accountId)),
    ),
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

function toCopy(conversation: ConversationSummary): CatchUpCopy {
  return {
    accountId: conversation.key.accountId,
    threadId: conversation.key.conversationId,
    inInbox: conversation.roles.includes("inbox"),
    unread: conversation.unread,
  };
}
