import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import { createMailHttpRequest } from "./http";
import { createWasmMailStore } from "./wasm-sqlite";
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
    onRebuild: () => {
      self.postMessage({ type: "rebuilding" } satisfies WorkerResponse);
    },
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
  let stopped = false;
  const loop = (async () => {
    while (!stopped) {
      try {
        await created.runUntil(Date.now() + 2000);
      } catch {
        await delay(1000);
      }
      await delay(250);
    }
  })();
  const originalClose = created.close.bind(created);
  return {
    ...created,
    ensureAccount,
    async close() {
      stopped = true;
      await originalClose();
      await loop;
    },
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
