import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { getListThreadKey } from "@/app/(app)/[emailAccountId]/mail/types";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import { decodeSnippet } from "@/utils/gmail/decode";

export const CATCH_UP_BATCH_SIZE = 10;

export type CatchUpAction = "archive" | "keep" | "snooze";

/** The same message in another account, which every card action reaches. */
export type CatchUpCopy = {
  accountId: string;
  threadId: string;
  /** Whether it is in its own inbox, so an undo puts it back where it was. */
  inInbox: boolean;
};

export type CatchUpItem = {
  /** The list's key for the conversation, which thread actions take. */
  key: string;
  threadId: string;
  accountId: string;
  latestMessageId: string;
  /** The latest message's Message-ID, normalized, which its copies share. */
  messageKey: string | null;
  /** Whether the conversation is in its inbox, as a label tab may show mail outside it. */
  inInbox: boolean;
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
    messageKey:
      normalizeInternetMessageId(conversation.latestInternetMessageId) ?? null,
    inInbox: conversation.roles.includes("inbox"),
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
 * is. The grouping runs over everything read, before a batch is cut from it.
 */
export function toCatchUpItems(
  conversations: ConversationSummary[],
  scope: CatchUpScope,
): CatchUpItem[] {
  return groupCopies(conversations, scope).flatMap((group) => {
    if (!group.some((member) => member.unread)) return [];
    const item = groupItem(group, scope);
    return item ? [item] : [];
  });
}

/**
 * Completes each card's copies from conversations read without the unread
 * filter, such as a copy already read in another account, or one past the
 * page the batch came from: archive, read and snooze must reach it too.
 */
export function withCatchUpCopies(
  state: CatchUpState,
  conversations: ConversationSummary[],
  scope: CatchUpScope,
): CatchUpState {
  if (!scope.combined || !conversations.length) return state;
  const byMessage = new Map<string, ConversationSummary[]>();
  for (const conversation of conversations) {
    const messageKey = normalizeInternetMessageId(
      conversation.latestInternetMessageId,
    );
    if (!messageKey) continue;
    byMessage.set(messageKey, [
      ...(byMessage.get(messageKey) ?? []),
      conversation,
    ]);
  }
  let changed = false;
  const items = state.items.map((item) => {
    const found = item.messageKey ? byMessage.get(item.messageKey) : undefined;
    if (!found) return item;
    const accounts = new Set([
      item.accountId,
      ...item.copies.map((copy) => copy.accountId),
    ]);
    const added = found.filter((conversation) => {
      if (accounts.has(conversation.key.accountId)) return false;
      accounts.add(conversation.key.accountId);
      return true;
    });
    if (!added.length) return item;
    changed = true;
    const copies = [...item.copies, ...added.map(toCopy)];
    const routed = added.find(
      (conversation) =>
        conversation.key.accountId === scope.combined?.routedAccountId,
    );
    if (!routed) return { ...item, copies };
    // The routed account has it after all: the card is its conversation.
    return (
      toCatchUpItem(routed, scope, [
        ...copies.filter((copy) => copy.accountId !== routed.key.accountId),
        {
          accountId: item.accountId,
          threadId: item.threadId,
          inInbox: item.inInbox,
        },
      ]) ?? { ...item, copies }
    );
  });
  return changed ? { ...state, items } : state;
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

/**
 * Conversations sharing their latest message's Message-ID, at most one per
 * account; one with no Message-ID is its own group.
 */
function groupCopies(
  conversations: ConversationSummary[],
  scope: CatchUpScope,
): ConversationSummary[][] {
  if (!scope.combined) return conversations.map((row) => [row]);
  const groups: ConversationSummary[][] = [];
  const open = new Map<string, ConversationSummary[][]>();
  for (const conversation of conversations) {
    const messageKey = normalizeInternetMessageId(
      conversation.latestInternetMessageId,
    );
    if (!messageKey) {
      groups.push([conversation]);
      continue;
    }
    const candidates = open.get(messageKey) ?? [];
    const group = candidates.find((members) =>
      members.every(
        (member) => member.key.accountId !== conversation.key.accountId,
      ),
    );
    if (group) {
      group.push(conversation);
      continue;
    }
    const created = [conversation];
    groups.push(created);
    open.set(messageKey, [...candidates, created]);
  }
  return groups;
}

/** A group's card: the routed account's copy when it has one. */
function groupItem(group: ConversationSummary[], scope: CatchUpScope) {
  const shown =
    group.find(
      (member) => member.key.accountId === scope.combined?.routedAccountId,
    ) ?? group[0];
  return toCatchUpItem(
    shown,
    scope,
    group.filter((member) => member !== shown).map(toCopy),
  );
}

function toCopy(conversation: ConversationSummary): CatchUpCopy {
  return {
    accountId: conversation.key.accountId,
    threadId: conversation.key.conversationId,
    inInbox: conversation.roles.includes("inbox"),
  };
}
