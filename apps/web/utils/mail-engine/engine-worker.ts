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
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol";
import { browserStoragePressure } from "./storage-pressure";
import { createMailWorkerHost } from "./worker-session";
import type { BrowserMailEngine } from "./create-browser-engine";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";

// Compiling sqlite-wasm takes a while and opens no files, so it starts as
// soon as the worker loads rather than when the engine starts.
preloadSqlite().catch(() => undefined);

const host = createMailWorkerHost({
  createEngine: createWorkerEngine,
  post: (message) => {
    self.postMessage(message);
  },
});

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  host.handle(event.data).catch((error) => {
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
  const runtime = createHostRuntime({
    storagePressure: browserStoragePressure,
  });
  const store = await createWasmMailStore({
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
  performance.mark("mail-engine:store-ready");
  const ensureAccount: BrowserMailEngine["ensureAccount"] = async (account) => {
    await store.ensureAccount({
      accountId: account.accountId,
      provider: account.provider,
      generation: account.generation ?? account.accountId,
    });
  };
  await ensureAccount(input);
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
  });
  if (shouldReleaseDeferredOnStart(input.online)) {
    await created.requestSync([input.accountId]);
  }
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
