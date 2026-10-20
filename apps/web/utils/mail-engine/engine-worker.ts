import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import { startEngineLoop } from "./engine-loop";
import { createMailHttpRequest } from "./http";
import { createWasmMailStore, preloadSqlite } from "./wasm-sqlite";
import {
  shouldReleaseDeferredOnStart,
  type BrowserEngineStart,
  type WorkerPreopenRequest,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import { browserStoragePressure } from "./storage-pressure";
import { createMailWorkerHost } from "./worker-session";
import type { BrowserMailEngine } from "./create-browser-engine";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";
import { PUSHED_CHANGES_CATCH_UP_INTERVAL_MS } from "@/utils/mail-engine/follow-mailbox-changes";

performance.mark("mail-engine:worker-loaded");
// Compiling sqlite-wasm takes a while and opens no files, so it starts as
// soon as the worker loads rather than when the engine starts.
preloadSqlite()
  .then(() => performance.mark("mail-engine:sqlite-ready"))
  .catch(() => undefined);

const runtime = createHostRuntime({
  storagePressure: browserStoragePressure,
});
// The mailbox the page asked to open before it named the account, which the
// engine's start takes over.
let preopened:
  | {
      maxPendingOperations: number | undefined;
      store: Promise<MailStore | null>;
      nameOwnedAccounts: (accountIds: string[]) => void;
    }
  | undefined;
let startReceived = false;

const host = createMailWorkerHost({
  createEngine: createWorkerEngine,
  post: (message) => {
    self.postMessage(message);
  },
});

self.onmessage = (
  event: MessageEvent<WorkerRequest | WorkerPreopenRequest>,
) => {
  const message = event.data;
  if (message.type === "preopen") {
    if (!startReceived && !preopened) preopenStore(message);
    return;
  }
  if (message.type === "start") {
    startReceived = true;
    performance.mark("mail-engine:start-received");
  }
  host.handle(message).catch((error) => {
    self.postMessage({
      id: "worker",
      type: "error",
      message: error instanceof Error ? error.message : "worker_error",
    });
  });
};

async function createWorkerEngine(
  input: BrowserEngineStart,
): Promise<BrowserMailEngine> {
  const store = (await takePreopenedStore(input)) ?? (await openStore(input));
  performance.mark("mail-engine:store-ready");
  const ensureAccount: BrowserMailEngine["ensureAccount"] = async (account) => {
    await store.ensureAccount({
      accountId: account.accountId,
      provider: account.provider,
      generation: account.generation ?? account.accountId,
    });
  };
  await ensureAccount(input);
  performance.mark("mail-engine:account-ensured");
  const ports = createRoutedBackendAdapter({
    requestFor: (accountId) =>
      createMailHttpRequest(accountId, () => {
        self.postMessage({ type: "session_expired" } satisfies WorkerResponse);
      }),
  });
  const created = createMailEngine({
    store,
    source: ports.source,
    executor: ports.executor,
    assistant: ports.assistant,
    runtime,
    ownerId: "browser-worker",
    changesCatchUpIntervalMs: PUSHED_CHANGES_CATCH_UP_INTERVAL_MS,
  });
  if (shouldReleaseDeferredOnStart(input.online)) {
    await created.requestSync([input.accountId]);
  }
  performance.mark("mail-engine:sync-requested");
  const loop = startEngineLoop(created);
  const originalClose = created.close.bind(created);
  return {
    ...created,
    ensureAccount,
    async close() {
      // The loop stops first, so its turn neither waits out its deadline nor
      // fails against the closed store and pauses before noticing.
      await loop.stop();
      await originalClose();
    },
  };
}

function openStore(input: {
  persist?: boolean;
  maxPendingOperations?: number;
  ownedAccountIds: string[] | Promise<string[]>;
}) {
  return createWasmMailStore({
    persist: input.persist,
    options: { maxPendingOperations: input.maxPendingOperations, runtime },
    ownedAccountIds: input.ownedAccountIds,
    onRebuild: () => {
      self.postMessage({ type: "rebuilding" } satisfies WorkerResponse);
    },
    onDropped: (drop) => {
      self.postMessage({ type: "dropped", drop } satisfies WorkerResponse);
    },
  });
}

// Opening the mailbox is most of the engine's start, and needs nothing the
// page learns from hydrating except which accounts a rebuild may carry work
// for; a rebuild waits for those, so it starts only once the engine does.
function preopenStore(message: WorkerPreopenRequest) {
  let nameOwnedAccounts: (accountIds: string[]) => void = () => undefined;
  const ownedAccountIds = new Promise<string[]>((resolve) => {
    nameOwnedAccounts = resolve;
  });
  preopened = {
    maxPendingOperations: message.maxPendingOperations,
    store: openStore({
      maxPendingOperations: message.maxPendingOperations,
      ownedAccountIds,
    }).catch(() => null),
    nameOwnedAccounts,
  };
}

// A start that wants another mailbox than the one opened early, or whose
// early open failed, opens its own.
async function takePreopenedStore(input: BrowserEngineStart) {
  const early = preopened;
  preopened = undefined;
  if (!early) return null;
  early.nameOwnedAccounts(input.ownedAccountIds);
  const store = await early.store;
  if (
    store &&
    input.persist !== false &&
    early.maxPendingOperations === input.maxPendingOperations
  ) {
    return store;
  }
  await store?.close().catch(() => undefined);
  return null;
}
