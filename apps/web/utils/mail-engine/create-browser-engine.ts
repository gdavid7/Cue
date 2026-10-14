import type { MailEngine, WorkAdmission } from "@inboxzero/mail-core/engine";
import type {
  MailboxView,
  QueryHandle,
  QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import {
  browserMailEngineCapabilities,
  pageConnectivityOnline,
  readPageMaxPendingOperations,
  requestSyncUnlessOffline,
  type BrowserEngineStart,
  type WorkerObserveKind,
  type WorkerRequest,
  type WorkerResponse,
} from "@/utils/mail-engine/worker-protocol";
import { finishPendingLocalMailboxWipe } from "@/utils/mail-engine/wipe-local-mailbox";

export { browserMailEngineCapabilities };

export type BrowserMailEngine = Omit<MailEngine, "ensureAccount"> & {
  ensureAccount(input: {
    accountId: string;
    provider: "google" | "microsoft";
    generation?: string;
  }): Promise<void>;
};

export async function createBrowserMailEngine(
  input: BrowserEngineStart,
): Promise<BrowserMailEngine> {
  // The previous user's mailbox must be gone before this one opens it.
  await finishPendingLocalMailboxWipe();
  const start: BrowserEngineStart = {
    ...input,
    maxPendingOperations:
      input.maxPendingOperations ?? readPageMaxPendingOperations(),
  };
  if (browserMailEngineCapabilities().worker) {
    try {
      return await createWorkerOwnedEngine(start);
    } catch {
      // Dedicated workers can fail in private mode or without module workers.
    }
  }
  // The engine, its store and SQLite normally load in the worker only, so the
  // page downloads them only on this fallback.
  const { createInTabEngine } = await import(
    "@/utils/mail-engine/in-tab-engine"
  );
  return createInTabEngine(start);
}

async function createWorkerOwnedEngine(
  input: BrowserEngineStart,
): Promise<BrowserMailEngine> {
  performance.mark("mail-engine:worker-create");
  const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), {
    type: "module",
  });
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const observations = new Map<
    string,
    {
      snapshot: QuerySnapshot<unknown>;
      listeners: Set<() => void>;
    }
  >();
  let closing: Promise<void> | undefined;

  worker.addEventListener("message", (event: MessageEvent<WorkerResponse>) => {
    const message = event.data;
    if (message.type === "snapshots") {
      // Every view takes its new state before any listener runs, so the page
      // renders the whole change once.
      const changed = message.snapshots.flatMap(({ handleId, snapshot }) => {
        const observation = observations.get(handleId);
        if (!observation) return [];
        observation.snapshot = snapshot;
        return [observation];
      });
      for (const observation of changed) {
        for (const listener of observation.listeners) listener();
      }
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.type === "ok") waiter.resolve(message.value);
    else waiter.reject(new Error(message.message));
  });
  worker.addEventListener("error", (event) => {
    for (const waiter of pending.values()) {
      waiter.reject(new Error(event.message || "mail engine worker failed"));
    }
    pending.clear();
  });

  await request(worker, pending, {
    id: crypto.randomUUID(),
    type: "start",
    input,
  });
  performance.mark("mail-engine:ready");

  function observe<T>(
    kind: WorkerObserveKind,
    args: unknown[],
  ): QueryHandle<T> & { handleId: string } {
    const handleId = crypto.randomUUID();
    const observation = {
      snapshot: {
        status: "loading",
        revision: null,
        data: null,
        refreshing: true,
        error: null,
      } satisfies QuerySnapshot<unknown>,
      listeners: new Set<() => void>(),
    };
    observations.set(handleId, observation);
    request(worker, pending, {
      id: crypto.randomUUID(),
      type: "observe",
      kind,
      handleId,
      args,
    }).catch(() => undefined);
    return {
      handleId,
      getSnapshot: () => observation.snapshot as QuerySnapshot<T>,
      subscribe: (listener) => {
        observation.listeners.add(listener);
        return () => observation.listeners.delete(listener);
      },
      close: () => {
        observations.delete(handleId);
        request(worker, pending, {
          id: crypto.randomUUID(),
          type: "unobserve",
          handleId,
        }).catch(() => undefined);
      },
    };
  }

  return {
    queryContactSuggestions: (query) =>
      callWorker(worker, pending, "queryContactSuggestions", [query]),
    observeMailbox: (query) => observe("mailbox", [query]),
    observeMailboxCounts: (query) => observe("mailboxCounts", [query]),
    observeMailboxWindow: (query) => {
      const handle = observe<MailboxView>("mailboxWindow", [query]);
      return {
        ...handle,
        loadMore: () =>
          request(worker, pending, {
            id: crypto.randomUUID(),
            type: "loadMore",
            handleId: handle.handleId,
          }) as Promise<void>,
      };
    },
    observeConversation: (key, page) => observe("conversation", [key, page]),
    observeOperation: (key) => observe("operation", [key]),
    submitMetadata: (payload) =>
      callWorker(worker, pending, "submitMetadata", [payload]),
    submitConversations: (payload) =>
      callWorker(worker, pending, "submitConversations", [payload]),
    saveDraft: (payload) => callWorker(worker, pending, "saveDraft", [payload]),
    readDraft: (payload) => callWorker(worker, pending, "readDraft", [payload]),
    submitSend: (payload) =>
      callWorker(worker, pending, "submitSend", [payload]),
    cancelOperation: (payload) =>
      callWorker(worker, pending, "cancelOperation", [payload]),
    requestSync: (accountIds) =>
      requestSyncUnlessOffline(pageConnectivityOnline(), () =>
        callWorker<WorkAdmission>(worker, pending, "requestSync", [accountIds]),
      ),
    ensureAccount: (account) =>
      callWorker<void>(worker, pending, "ensureAccount", [account]),
    ensureMessageContent: (key) =>
      callWorker(worker, pending, "ensureMessageContent", [key]),
    getDiagnostics: (accountId) =>
      callWorker(worker, pending, "getDiagnostics", [accountId]),
    purgeAccount: (accountId) =>
      callWorker(worker, pending, "purgeAccount", [accountId]),
    retainAccounts: (accountIds) =>
      callWorker<void>(worker, pending, "retainAccounts", [accountIds]),
    inspect: () => callWorker(worker, pending, "inspect", []),
    runUntil: (deadlineMs) =>
      callWorker(worker, pending, "runUntil", [deadlineMs]),
    // Sign-out closes the engine from the host and through the active client
    // at once; both callers must share one close or one waits forever on a
    // worker the other terminated.
    close() {
      closing ??= (async () => {
        try {
          await request(worker, pending, {
            id: crypto.randomUUID(),
            type: "close",
          });
        } finally {
          // SAHPool keeps OPFS handles until the worker is gone, even if the
          // graceful close RPC fails.
          worker.terminate();
          // A terminated worker never answers, so settle whatever still waits.
          for (const waiter of pending.values()) {
            waiter.reject(new Error("mail engine worker closed"));
          }
          pending.clear();
        }
      })();
      return closing;
    },
  };
}

function request(
  worker: Worker,
  pending: Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >,
  message: WorkerRequest,
) {
  return new Promise((resolve, reject) => {
    pending.set(message.id, { resolve, reject });
    worker.postMessage(message);
  });
}

function callWorker<T>(
  worker: Worker,
  pending: Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >,
  method: string,
  args: unknown[],
) {
  return request(worker, pending, {
    id: crypto.randomUUID(),
    type: "call",
    method,
    args,
  }) as Promise<T>;
}
