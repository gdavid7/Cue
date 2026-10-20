import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationKey } from "@inboxzero/mail-core/identities";
import type { OperationState } from "@inboxzero/mail-core/operations";
import type { QueryHandle } from "@inboxzero/mail-core/queries";

let activeMailClient: MailClient | null = null;
const logoutListeners = new Set<() => void>();
const clientListeners = new Set<() => void>();

export function setActiveMailClient(client: MailClient | null) {
  if (activeMailClient === client) return;
  activeMailClient = client;
  for (const listener of [...clientListeners]) listener();
}

export function getActiveMailClient() {
  return activeMailClient;
}

export function subscribeActiveMailClient(listener: () => void) {
  clientListeners.add(listener);
  return () => {
    clientListeners.delete(listener);
  };
}

/**
 * Watches an operation on whichever engine is running. A retry, a rebuilt
 * mailbox or another tab taking over replaces the engine a send was queued
 * on, and a view on the replaced one never changes again; the engine that
 * replaces it opens the same mailbox, so the operation is watched there.
 */
export function observeOperationOnActiveEngine(
  client: MailClient,
  key: OperationKey,
): QueryHandle<OperationState> & { readonly client: MailClient } {
  let current = client;
  let handle = client.observeOperation(key);
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of [...listeners]) listener();
  };
  let unsubscribeHandle = handle.subscribe(notify);
  const unsubscribeClient = subscribeActiveMailClient(() => {
    const next = getActiveMailClient();
    if (!next || next === current) return;
    unsubscribeHandle();
    handle.close();
    current = next;
    handle = next.observeOperation(key);
    unsubscribeHandle = handle.subscribe(notify);
    notify();
  });
  return {
    get client() {
      return current;
    },
    getSnapshot: () => handle.getSnapshot(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      unsubscribeClient();
      unsubscribeHandle();
      listeners.clear();
      handle.close();
    },
  };
}

export function subscribeMailEngineLogout(listener: () => void) {
  logoutListeners.add(listener);
  return () => {
    logoutListeners.delete(listener);
  };
}

export async function closeActiveMailEngine() {
  for (const listener of [...logoutListeners]) listener();
  const client = activeMailClient;
  setActiveMailClient(null);
  if (!client) return;
  try {
    await client.close?.();
  } catch {
    // Logout still proceeds if the worker is already gone.
  }
}
