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
  latestMessageId?: string;
  sender: string;
  subject: string;
  preview: string;
  atMs: number;
};

/**
 * One batch, fixed when it starts so the card never reshuffles as the
 * mailbox catches up behind it. `history` is the order actions were taken,
 * which undo walks back.
 */
export type CatchUpState = {
  items: CatchUpItem[];
  acted: Record<string, CatchUpAction>;
  history: string[];
};

/** The unread conversations in a mailbox view, as the card shows them. */
export function toCatchUpItems(
  conversations: ConversationSummary[],
): CatchUpItem[] {
  return conversations.flatMap((conversation) => {
    // A conversation that is only a draft has nothing to read yet.
    if (!conversation.unread || !conversation.latestMessageId) return [];
    const from = conversation.senders.at(-1) || conversation.from;
    return [
      {
        key: getListThreadKey({ id: conversation.key.conversationId }),
        threadId: conversation.key.conversationId,
        accountId: conversation.key.accountId,
        latestMessageId: conversation.latestMessageId,
        sender: extractNameFromEmail(from) || extractEmailAddress(from),
        subject: conversation.subject,
        preview: decodeSnippet(conversation.preview),
        atMs: conversation.latestMessageAtMs,
      },
    ];
  });
}

/** The oldest conversations first, up to a batch, past any already acted on. */
export function startCatchUp(
  items: CatchUpItem[],
  {
    batchSize = CATCH_UP_BATCH_SIZE,
    skip,
  }: { batchSize?: number; skip?: ReadonlySet<string> } = {},
): CatchUpState {
  return {
    items: items
      .filter((item) => !skip?.has(item.key))
      .sort((a, b) => a.atMs - b.atMs || a.key.localeCompare(b.key))
      .slice(0, batchSize),
    acted: {},
    history: [],
  };
}

export function currentCatchUpItem(state: CatchUpState): CatchUpItem | null {
  return state.items.find((item) => !state.acted[item.key]) ?? null;
}

export function catchUpLeft(state: CatchUpState) {
  return state.items.filter((item) => !state.acted[item.key]).length;
}

export function actOnCatchUp(
  state: CatchUpState,
  key: string,
  action: CatchUpAction,
): CatchUpState {
  if (state.acted[key] || !state.items.some((item) => item.key === key))
    return state;
  return {
    ...state,
    acted: { ...state.acted, [key]: action },
    history: [...state.history, key],
  };
}

/**
 * Takes back the last action. Batches are worked oldest first, so the
 * conversation it brings back is the current one again.
 */
export function undoCatchUp(state: CatchUpState): {
  state: CatchUpState;
  undone: { key: string; action: CatchUpAction } | null;
} {
  const key = state.history.at(-1);
  const action = key ? state.acted[key] : undefined;
  if (!key || !action) return { state, undone: null };
  const { [key]: _removed, ...acted } = state.acted;
  return {
    state: { ...state, acted, history: state.history.slice(0, -1) },
    undone: { key, action },
  };
}
