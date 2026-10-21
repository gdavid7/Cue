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
// A page that just closed or reloaded can hold the engine's owner lock for a
// moment, so an early open asks for it again a few times.
const EARLY_OWNER_LOCK_RETRY_MS = 100;
const EARLY_OWNER_LOCK_ATTEMPTS = 20;

let prewarmed: {
  worker: Worker;
  timer: ReturnType<typeof setTimeout>;
  /** Its script failed before a start could listen for that. */
  failed: boolean;
} | null = null;
// The engine's owner lock, taken while the page hydrates so its early worker
// can open the mailbox. No other tab can own the engine, and so open its
// files, until this page's engine start claims the lock or the page lets it go.
let earlyOwner: EarlyOwnerLock | null = null;

type EarlyOwnerLock = {
  /** The latest request for the lock: whether this page took it. */
  attempt: Promise<boolean>;
  /** Its answer, once it came. */
  held?: boolean;
  retry?: ReturnType<typeof setTimeout>;
  state: "asking" | "claimed" | "released";
  release: () => void;
};
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
  // The previous user's mailbox must be gone before this one opens it. Only
  // a pending wipe is awaited, so a start goes out to the worker in the task
  // that asked for it.
  if (isLocalMailboxWipePending()) {
    // An early worker may have opened the signed-out mailbox, and holds its
    // files until it is gone.
    releasePrewarmedMailEngineWorker();
    await finishPendingLocalMailboxWipe();
    if (isLocalMailboxWipePending()) {
      throw new Error("The signed-out mailbox could not be wiped");
    }
  }
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
 * hydrating, and opens the mailbox too once this page takes the engine's
 * owner lock, as no other tab owns the engine. None is started while a
 * sign-out wipe is unfinished, since that wipe must come before any mailbox
 * opens.
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
    letGoOfEarlyOwnerLock();
  }, PREWARMED_WORKER_IDLE_MS);
  const record = { worker, timer, failed: false };
  worker.addEventListener("error", () => {
    record.failed = true;
  });
  prewarmed = record;
  earlyOwner = askForOwnerLockEarly(worker);
}

/**
 * Lets go of an early worker this page will not start, such as when another
 * tab owns the engine, so a mailbox it opened early holds no files, and of
 * the owner lock it took for that.
 */
export function releasePrewarmedMailEngineWorker() {
  const worker = takePrewarmedWorker();
  worker?.terminate();
  letGoOfEarlyOwnerLock();
}

/**
 * Hands the owner lock this page took while it hydrated to the engine's
 * start, which then holds it until it calls the returned function. Null when
 * the page holds none and must ask for the lock itself; this page stops
 * asking early either way, so the two requests never wait on each other.
 * Only a request still unanswered returns a promise, so a start that already
 * holds the lock goes out in the same task, not after the page's other work.
 */
export function claimEarlyMailEngineOwnerLock():
  | (() => void)
  | null
  | Promise<(() => void) | null> {
  const owner = earlyOwner;
  earlyOwner = null;
  if (!owner) return null;
  owner.state = "claimed";
  clearTimeout(owner.retry);
  if (owner.held !== undefined) return owner.held ? owner.release : null;
  return owner.attempt.then((held) => (held ? owner.release : null));
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
    queryPersonCard: (query) =>
      callWorker(worker, pending, "queryPersonCard", [query]),
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
  const { worker, failed } = prewarmed;
  prewarmed = null;
  // It would never answer a start.
  if (failed) {
    worker.terminate();
    return null;
  }
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

function askForOwnerLockEarly(worker: Worker): EarlyOwnerLock | null {
  const locks = typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!locks?.request || !browserMailEngineCapabilities().opfs) return null;
  const owner: EarlyOwnerLock = {
    attempt: Promise.resolve(false),
    state: "asking",
    release: () => undefined,
  };
  const ask = (attemptsLeft: number) => {
    owner.held = undefined;
    owner.attempt = new Promise<boolean>((resolve) => {
      locks
        .request(MAIL_ENGINE_OWNER_LOCK, { ifAvailable: true }, (lock) => {
          if (!lock || owner.state === "released") {
            owner.held = false;
            resolve(false);
            if (!lock && owner.state === "asking" && attemptsLeft > 1) {
              owner.retry = setTimeout(
                () => ask(attemptsLeft - 1),
                EARLY_OWNER_LOCK_RETRY_MS,
              );
            }
            return;
          }
          const held = new Promise<void>((letGo) => {
            owner.release = letGo;
          });
          owner.held = true;
          resolve(true);
          // The engine's start takes over the mailbox opened here.
          worker.postMessage({
            type: "preopen",
            maxPendingOperations: readPageMaxPendingOperations(),
          } satisfies WorkerPreopenRequest);
          return held;
        })
        .catch(() => {
          owner.held = false;
          resolve(false);
        });
    });
  };
  ask(EARLY_OWNER_LOCK_ATTEMPTS);
  return owner;
}

function letGoOfEarlyOwnerLock() {
  const owner = earlyOwner;
  earlyOwner = null;
  if (!owner) return;
  owner.state = "released";
  clearTimeout(owner.retry);
  owner.attempt.then((held) => {
    if (held) owner.release();
  });
}
