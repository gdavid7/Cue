import {
  createMailEngine,
  createHostRuntime,
  type MailEngine,
  type WorkAdmission,
} from "@inboxzero/mail-core/engine";
import { classifyMailboxError } from "@inboxzero/mail-sqlite/recovery";
import type {
  MailboxView,
  QueryHandle,
  QuerySnapshot,
} from "@inboxzero/mail-core/queries";
import { createMailHttpRequest } from "@/utils/mail-engine/http";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";
import { createWasmMailStore } from "@/utils/mail-engine/wasm-sqlite";
import {
  browserMailEngineCapabilities,
  pageConnectivityOnline,
  readPageMaxPendingOperations,
  requestSyncUnlessOffline,
  shouldReleaseDeferredOnStart,
  type BrowserEngineStart,
  type WorkerObserveKind,
  type WorkerRequest,
  type WorkerResponse,
} from "@/utils/mail-engine/worker-protocol";
import { browserStoragePressure } from "@/utils/mail-engine/storage-pressure";
import { finishPendingLocalMailboxWipe } from "@/utils/mail-engine/wipe-local-mailbox";

export { browserMailEngineCapabilities };

// A closing tab's worker can hold the mailbox's OPFS handles for a moment
// after its lock is released; these waits cover that without a dead end.
const BUSY_START_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];

type BrowserEngineHooks = {
  /** Called when a corrupt mailbox is being rebuilt during start. */
  onRebuild?: () => void;
};

export type BrowserMailEngine = Omit<MailEngine, "ensureAccount"> & {
  ensureAccount(input: {
    accountId: string;
    provider: "google" | "microsoft";
    generation?: string;
  }): Promise<void>;
};

export async function createBrowserMailEngine(
  input: BrowserEngineStart,
  hooks: BrowserEngineHooks = {},
): Promise<BrowserMailEngine> {
  // The previous user's mailbox must be gone before this one opens it.
  await finishPendingLocalMailboxWipe();
  const start: BrowserEngineStart = {
    ...input,
    maxPendingOperations:
      input.maxPendingOperations ?? readPageMaxPendingOperations(),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await startBrowserEngine(start, hooks);
    } catch (error) {
      const retryInMs = BUSY_START_RETRY_DELAYS_MS[attempt];
      if (classifyMailboxError(error) !== "busy" || retryInMs === undefined) {
        throw error;
      }
      await delay(retryInMs);
    }
  }
}

async function startBrowserEngine(
  start: BrowserEngineStart,
  hooks: BrowserEngineHooks,
) {
  if (browserMailEngineCapabilities().worker) {
    try {
      return await createWorkerOwnedEngine(start, hooks);
    } catch (error) {
      // The tab would wait on the same held files, so retry the worker.
      if (classifyMailboxError(error) === "busy") throw error;
      // Dedicated workers can fail in private mode or without module workers.
    }
  }
  return createInTabEngine(start, hooks);
}

async function createInTabEngine(
  input: BrowserEngineStart,
  hooks: BrowserEngineHooks,
): Promise<BrowserMailEngine> {
  const runtime = createHostRuntime({
    storagePressure: browserStoragePressure,
  });
  const store = await createWasmMailStore({
    persist: input.persist,
    options: { maxPendingOperations: input.maxPendingOperations, runtime },
    ownedAccountIds: input.ownedAccountIds,
    onRebuild: hooks.onRebuild,
  });
  const ensureAccount: BrowserMailEngine["ensureAccount"] = async (account) => {
    await store.ensureAccount({
      accountId: account.accountId,
      provider: account.provider,
      generation: account.generation ?? account.accountId,
    });
  };
  await ensureAccount(input);
  const ports = createRoutedBackendAdapter({
    requestFor: createMailHttpRequest,
  });
  const engine = createMailEngine({
    store,
    source: ports.source,
    executor: ports.executor,
    assistant: ports.assistant,
    runtime,
    ownerId: "browser-owner",
  });
  if (shouldReleaseDeferredOnStart(input.online)) {
    await engine.requestSync([input.accountId]);
  }
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        await engine.runUntil(Date.now() + 2000);
      } catch {
        await delay(1000);
      }
      await delay(250);
    }
  })();
  const originalClose = engine.close.bind(engine);
  const originalRequestSync = engine.requestSync.bind(engine);
  return {
    ...engine,
    // Local autocomplete stays off the UI thread if dedicated workers fail.
    queryContactSuggestions: undefined,
    ensureAccount,
    requestSync: (accountIds) =>
      requestSyncUnlessOffline(pageConnectivityOnline(), () =>
        originalRequestSync(accountIds),
      ),
    async close() {
      stopped = true;
      await originalClose();
      await loop;
    },
  };
}

async function createWorkerOwnedEngine(
  input: BrowserEngineStart,
  hooks: BrowserEngineHooks,
): Promise<BrowserMailEngine> {
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
    if (message.type === "rebuilding") {
      hooks.onRebuild?.();
      return;
    }
    if (message.type === "snapshot") {
      const observation = observations.get(message.handleId);
      if (!observation) return;
      observation.snapshot = message.snapshot;
      for (const listener of observation.listeners) listener();
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

  try {
    await request(worker, pending, {
      id: crypto.randomUUID(),
      type: "start",
      input,
    });
  } catch (error) {
    // The worker may already hold the mailbox's OPFS handles, which the
    // in-tab fallback needs.
    worker.terminate();
    throw error;
  }

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
