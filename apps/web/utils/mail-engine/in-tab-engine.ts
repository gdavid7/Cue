import {
  createMailEngine,
  createHostRuntime,
} from "@inboxzero/mail-core/engine";
import { createSqliteMailStore } from "@inboxzero/mail-sqlite/store";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";
import type { BrowserMailEngine } from "@/utils/mail-engine/create-browser-engine";
import { createMailHttpRequest } from "@/utils/mail-engine/http";
import { browserStoragePressure } from "@/utils/mail-engine/storage-pressure";
import { createWasmSqliteDriver } from "@/utils/mail-engine/wasm-sqlite";
import {
  pageConnectivityOnline,
  requestSyncUnlessOffline,
  shouldReleaseDeferredOnStart,
  type BrowserEngineStart,
} from "@/utils/mail-engine/worker-protocol";

/** The engine on the page itself, for browsers whose dedicated workers fail. */
export async function createInTabEngine(
  input: BrowserEngineStart,
): Promise<BrowserMailEngine> {
  const driver = await createWasmSqliteDriver({ persist: input.persist });
  const runtime = createHostRuntime({
    storagePressure: browserStoragePressure,
  });
  const store = await createSqliteMailStore(driver, {
    maxPendingOperations: input.maxPendingOperations,
    runtime,
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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
