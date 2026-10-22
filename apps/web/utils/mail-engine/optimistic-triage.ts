import { useCallback, useSyncExternalStore } from "react";
import type { MetadataChange } from "@inboxzero/mail-core/commands";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { Provider } from "@inboxzero/mail-core/identities";
import type {
  ConversationSummary,
  MailPredicate,
} from "@inboxzero/mail-core/queries";
import { conversationMatchesAfterChange } from "@inboxzero/mail-core/query-semantics";

/**
 * A triage change the page shows before the mail engine has written it. The
 * engine refreshes its views before it admits a change, so by the time the
 * admission arrives the views already show it and the entry can go; until
 * then it keeps snapshots taken before the change from bringing a row back.
 */
type OptimisticTriage = {
  id: number;
  accountId: string;
  conversationIds: ReadonlySet<string>;
  change: MetadataChange;
};

type TriageStore = {
  entries: readonly OptimisticTriage[];
  listeners: Set<() => void>;
};

const NO_ENTRIES: readonly OptimisticTriage[] = [];
const stores = new WeakMap<MailClient, TriageStore>();
let nextId = 0;

/** Shows `change` at once and returns how to retire it, admitted or not. */
export function beginOptimisticTriage(
  client: MailClient,
  input: {
    accountId: string;
    conversationIds: string[];
    change: MetadataChange;
  },
): () => void {
  const store = storeFor(client);
  const id = ++nextId;
  update(store, [
    ...store.entries,
    {
      id,
      accountId: input.accountId,
      conversationIds: new Set(input.conversationIds),
      change: input.change,
    },
  ]);
  return () => {
    update(
      store,
      store.entries.filter((entry) => entry.id !== id),
    );
  };
}

export function readOptimisticTriage(
  client: MailClient,
): readonly OptimisticTriage[] {
  return stores.get(client)?.entries ?? NO_ENTRIES;
}

export function subscribeOptimisticTriage(
  client: MailClient,
  listener: () => void,
) {
  const { listeners } = storeFor(client);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useOptimisticTriage(client: MailClient | null) {
  const subscribe = useCallback(
    (listener: () => void) =>
      client ? subscribeOptimisticTriage(client, listener) : () => undefined,
    [client],
  );
  const read = useCallback(
    () => (client ? readOptimisticTriage(client) : NO_ENTRIES),
    [client],
  );
  return useSyncExternalStore(subscribe, read, () => NO_ENTRIES);
}

/**
 * The view's rows with pending triage applied: read and star show on the row,
 * and a conversation the change takes out of the view is left out. A row the
 * change cannot decide stays until the engine's own view settles it.
 * `providers` names each account's provider, which decides whether a change
 * reaches the user's own Sent and Drafts copies; an account missing from it
 * leaves those views to the engine.
 */
export function applyOptimisticTriage(
  conversations: ConversationSummary[],
  predicate: MailPredicate,
  entries: readonly OptimisticTriage[],
  providers: ReadonlyMap<string, Provider>,
): ConversationSummary[] {
  if (!entries.length) return conversations;
  let changed = false;
  const shown = conversations.flatMap((conversation) => {
    let row = conversation;
    let inView: boolean | null = null;
    for (const entry of entries) {
      if (
        entry.accountId !== conversation.key.accountId ||
        !entry.conversationIds.has(conversation.key.conversationId)
      ) {
        continue;
      }
      row = withChange(row, entry.change);
      inView =
        conversationMatchesAfterChange(
          predicate,
          entry.change,
          providers.get(entry.accountId) ?? null,
        ) ?? inView;
    }
    if (inView === false) {
      changed = true;
      return [];
    }
    if (row !== conversation) changed = true;
    return [row];
  });
  return changed ? shown : conversations;
}

function withChange(
  row: ConversationSummary,
  change: MetadataChange,
): ConversationSummary {
  if (change.kind === "set_read" && row.unread === change.read) {
    return { ...row, unread: !change.read };
  }
  if (change.kind === "set_starred" && row.starred !== change.starred) {
    return { ...row, starred: change.starred };
  }
  return row;
}

function storeFor(client: MailClient) {
  let store = stores.get(client);
  if (!store) {
    store = { entries: NO_ENTRIES, listeners: new Set() };
    stores.set(client, store);
  }
  return store;
}

function update(store: TriageStore, entries: readonly OptimisticTriage[]) {
  store.entries = entries.length ? entries : NO_ENTRIES;
  for (const listener of store.listeners) listener();
}
