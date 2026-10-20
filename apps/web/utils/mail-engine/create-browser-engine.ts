import type { MailEngine, WorkAdmission } from "@inboxzero/mail-core/engine";
import { classifyMailboxError } from "@inboxzero/mail-sqlite/mailbox-errors";
import type { DroppedMailWork } from "@inboxzero/mail-sqlite/recovery";
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
  type WorkerPreopenRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "@/utils/mail-engine/worker-protocol";
import { MAIL_ENGINE_OWNER_LOCK } from "@/utils/mail-engine/tab-channel";
import {
  finishPendingLocalMailboxWipe,
  isLocalMailboxWipePending,
} from "@/utils/mail-engine/wipe-local-mailbox";
import { createClientLogger } from "@/utils/logger-client";
import { notifySessionExpired } from "@/utils/session-expired";

export { browserMailEngineCapabilities };

const logger = createClientLogger("mail-engine");

// A closing tab's worker can hold the mailbox's OPFS handles for a moment
// after its lock is released; these waits cover that without a dead end.
const BUSY_START_RETRY_DELAYS_MS = [250, 500, 1000, 2000, 4000];
// A start can itself wait out another tab's file lock, so retries stop once
// the whole start has taken this long rather than multiplying that wait.
const BUSY_START_BUDGET_MS = 10_000;
// An early worker this tab never starts, as when another tab owns the engine,
// is let go after this long.
const PREWARMED_WORKER_IDLE_MS = 30_000;

let prewarmed: {
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
} | null = null;
// The worker asks for SQLite's wasm only once its own scripts have loaded and
// run. Asked for here as the worker is created, the two download together,
// and the worker's own request is answered from the cache.
const SQLITE_WASM_URL = new URL(
  "../../node_modules/@sqlite.org/sqlite-wasm/dist/sqlite3.wasm",
  import.meta.url,
);
let sqliteWasmRequested = false;

export type BrowserEngineHooks = {
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
  const startedAt = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      return await startBrowserEngine(start, hooks);
    } catch (error) {
      const retryInMs = BUSY_START_RETRY_DELAYS_MS[attempt];
      if (
        classifyMailboxError(error) !== "busy" ||
        retryInMs === undefined ||
        Date.now() - startedAt + retryInMs > BUSY_START_BUDGET_MS
      ) {
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
  // The engine, its store and SQLite normally load in the worker only, so the
  // page downloads them only on this fallback.
  const { createInTabEngine } = await import(
    "@/utils/mail-engine/in-tab-engine"
  );
  return createInTabEngine(start, hooks);
}

/**
 * Starts loading the engine worker and SQLite while the page is still
 * hydrating, and opens the mailbox too when no tab owns the engine, so this
 * page is about to. None is started while a sign-out wipe is unfinished,
 * since that wipe must come before any mailbox opens.
 */
export function prewarmMailEngineWorker() {
  if (
    prewarmed ||
    !browserMailEngineCapabilities().worker ||
    isLocalMailboxWipePending()
  ) {
    return;
  }
  performance.mark("mail-engine:prewarm");
  const worker = createEngineWorker();
  const timer = setTimeout(() => {
    if (prewarmed?.worker !== worker) return;
    prewarmed = null;
    worker.terminate();
  }, PREWARMED_WORKER_IDLE_MS);
  prewarmed = { worker, timer };
  preopenUnlessOwned(worker);
}

/**
 * Lets go of an early worker this page will not start, such as when another
 * tab owns the engine, so a mailbox it opened early holds no files.
 */
export function releasePrewarmedMailEngineWorker() {
  const worker = takePrewarmedWorker();
  worker?.terminate();
}

async function createWorkerOwnedEngine(
  input: BrowserEngineStart,
  hooks: BrowserEngineHooks,
): Promise<BrowserMailEngine> {
  performance.mark("mail-engine:worker-create");
  const worker = takePrewarmedWorker() ?? createEngineWorker();
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
    if (message.type === "dropped") {
      logDroppedWork(message.drop);
      return;
    }
    if (message.type === "session_expired") {
      notifySessionExpired();
      return;
    }
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
    searchMessages: (query) =>
      callWorker(worker, pending, "searchMessages", [query]),
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
    ensureConversationMessages: (key) =>
      callWorker(worker, pending, "ensureConversationMessages", [key]),
    releaseConversationMessages: (key) =>
      callWorker<void>(worker, pending, "releaseConversationMessages", [key]),
    getDiagnostics: (accountId) =>
      callWorker(worker, pending, "getDiagnostics", [accountId]),
    forgetDeletedDrafts: (input) =>
      callWorker<void>(worker, pending, "forgetDeletedDrafts", [input]),
    ingestMessages: (input) =>
      callWorker<void>(worker, pending, "ingestMessages", [input]),
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

export function logDroppedWork(drop: DroppedMailWork) {
  logger.warn("Mailbox rebuild left out carried work", drop);
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function takePrewarmedWorker() {
  if (!prewarmed) return null;
  clearTimeout(prewarmed.timer);
  const { worker } = prewarmed;
  prewarmed = null;
  return worker;
}

function createEngineWorker() {
  const worker = new Worker(new URL("./engine-worker.ts", import.meta.url), {
    type: "module",
  });
  if (!sqliteWasmRequested) {
    sqliteWasmRequested = true;
    fetch(SQLITE_WASM_URL)
      .then((response) => response.arrayBuffer())
      .catch(() => undefined);
  }
  return worker;
}

function preopenUnlessOwned(worker: Worker) {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.query || !browserMailEngineCapabilities().opfs) return;
  locks
    .query()
    .then(({ held = [], pending = [] }) => {
      // Taken means the engine already sent its start, which opens the mailbox.
      if (prewarmed?.worker !== worker) return;
      if ([...held, ...pending].some(isOwnerLock)) return;
      worker.postMessage({
        type: "preopen",
        maxPendingOperations: readPageMaxPendingOperations(),
      } satisfies WorkerPreopenRequest);
    })
    .catch(() => undefined);
}

function isOwnerLock(lock: LockInfo) {
  return lock.name === MAIL_ENGINE_OWNER_LOCK;
}
