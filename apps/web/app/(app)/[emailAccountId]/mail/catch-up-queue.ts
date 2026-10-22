import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { getListThreadKey } from "@/app/(app)/[emailAccountId]/mail/types";
import { extractEmailAddress, extractNameFromEmail } from "@/utils/email";
import { decodeSnippet } from "@/utils/gmail/decode";

export const CATCH_UP_BATCH_SIZE = 10;

export type CatchUpAction = "archive" | "keep" | "snooze";

export type CatchUpItem = {
  /** The list's key for the conversation, which thread actions take. */
  key: string;
  threadId: string;
  accountId: string;
  latestMessageId: string;
  sender: string;
  subject: string;
  preview: string;
  atMs: number;
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
};

export function toCatchUpItem(
  conversation: ConversationSummary,
  ownEmail: string,
): CatchUpItem | null {
  // A conversation that is only a draft has nothing to read yet.
  if (!conversation.latestMessageId) return null;
  const own = ownEmail.toLowerCase();
  // Who it's with: the latest sender who isn't the user, as Today names it.
  const from =
    conversation.senders.findLast(
      (sender) => extractEmailAddress(sender).toLowerCase() !== own,
    ) || conversation.from;
  return {
    key: getListThreadKey({ id: conversation.key.conversationId }),
    threadId: conversation.key.conversationId,
    accountId: conversation.key.accountId,
    latestMessageId: conversation.latestMessageId,
    sender: extractNameFromEmail(from) || extractEmailAddress(from),
    subject: conversation.subject,
    preview: decodeSnippet(conversation.preview),
    atMs: conversation.latestMessageAtMs,
  };
}

/** The unread conversations in a mailbox view, as the card shows them. */
export function toCatchUpItems(
  conversations: ConversationSummary[],
  ownEmail: string,
): CatchUpItem[] {
  return conversations.flatMap((conversation) => {
    if (!conversation.unread) return [];
    const item = toCatchUpItem(conversation, ownEmail);
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
  };
}

export function currentCatchUpItem(state: CatchUpState): CatchUpItem | null {
  return state.items.find((item) => isOpen(state, item.key)) ?? null;
}

export function catchUpLeft(state: CatchUpState) {
  return state.items.filter((item) => isOpen(state, item.key)).length;
}

export function actOnCatchUp(
  state: CatchUpState,
  key: string,
  action: CatchUpAction,
): CatchUpState {
  if (!state.items.some((item) => item.key === key && isOpen(state, item.key)))
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
        items: next.items.map((entry) =>
          entry.key === item.key ? now : entry,
        ),
      };
    }
  }
  return next;
}

function isOpen(state: CatchUpState, key: string) {
  return !state.acted[key] && !state.skipped[key];
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
