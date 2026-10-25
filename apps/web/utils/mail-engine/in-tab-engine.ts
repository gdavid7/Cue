import { describeMailEngineCapabilities } from "@inboxzero/mail-core/capabilities";
import {
  createMailEngine,
  createHostRuntime,
} from "@inboxzero/mail-core/engine";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";
import {
  logDroppedWork,
  type BrowserEngineHooks,
  type BrowserMailEngine,
} from "@/utils/mail-engine/create-browser-engine";
import { startEngineLoop } from "@/utils/mail-engine/engine-loop";
import { createMailHttpRequest } from "@/utils/mail-engine/http";
import { browserStoragePressure } from "@/utils/mail-engine/storage-pressure";
import { createWasmMailStore } from "@/utils/mail-engine/wasm-sqlite";
import { notifySessionExpired } from "@/utils/session-expired";
import { noteServerBuild } from "@/utils/build-update";
import {
  pageConnectivityOnline,
  requestSyncUnlessOffline,
  shouldReleaseDeferredOnStart,
  type BrowserEngineStart,
} from "@/utils/mail-engine/worker-protocol";
import { PUSHED_CHANGES_CATCH_UP_INTERVAL_MS } from "@/utils/mail-engine/follow-mailbox-changes";

/** The engine on the page itself, for browsers whose dedicated workers fail. */
export async function createInTabEngine(
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
    onDropped: logDroppedWork,
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
    requestFor: (accountId) =>
      createMailHttpRequest(accountId, notifySessionExpired, noteServerBuild),
  });
  const engine = createMailEngine({
    store,
    source: ports.source,
    executor: ports.executor,
    assistant: ports.assistant,
    runtime,
    ownerId: "browser-owner",
    changesCatchUpIntervalMs: PUSHED_CHANGES_CATCH_UP_INTERVAL_MS,
  });
  if (shouldReleaseDeferredOnStart(input.online)) {
    await engine.requestSync([input.accountId]);
  }
  const loop = startEngineLoop(engine);
  const originalClose = engine.close.bind(engine);
  const originalRequestSync = engine.requestSync.bind(engine);
  const client: BrowserMailEngine = {
    ...engine,
    // Local autocomplete, the person card, the sender check, the Files view,
    // Today's Waiting on you and "Mail you never read", and the assistant's
    // message search stay off the UI thread if dedicated workers fail; before
    // indexing completes a search can scan the mailbox, so the assistant
    // searches Gmail instead.
    queryContactSuggestions: undefined,
    searchMessages: undefined,
    queryPersonCard: undefined,
    queryNeverReadSenders: undefined,
    querySenderHistory: undefined,
    queryFiles: undefined,
    queryFileSenders: undefined,
    queryFilesNotOnDevice: undefined,
    queryWaitingOnYou: undefined,
    ensureAccount,
    requestSync: (accountIds) =>
      requestSyncUnlessOffline(pageConnectivityOnline(), () =>
        originalRequestSync(accountIds),
      ),
    async close() {
      // The loop stops first, so its turn neither waits out its deadline nor
      // fails against the closed store and pauses before noticing.
      await loop.stop();
      await originalClose();
    },
  };
  // Reported after the methods this host leaves out are gone.
  return { ...client, capabilities: describeMailEngineCapabilities(client) };
}
