import {
  createHostRuntime,
  createMailEngine,
} from "@inboxzero/mail-core/engine";
import { startEngineLoop } from "./engine-loop";
import { createMailHttpRequest } from "./http";
import { resetSessionGone } from "@/utils/session-refresh";
import { createWasmMailStore, preloadSqlite } from "./wasm-sqlite";
import {
  shouldReleaseDeferredOnStart,
  type BrowserEngineStart,
  type WorkerPreopenRequest,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerSessionResetRequest,
} from "./worker-protocol";
import type { MailStore } from "@inboxzero/mail-core/ports/mail-store";
import { classifyMailboxError } from "@inboxzero/mail-sqlite/mailbox-errors";
import { browserStoragePressure } from "./storage-pressure";
import { createMailWorkerHost } from "./worker-session";
import type { BrowserMailEngine } from "./create-browser-engine";
import { createRoutedBackendAdapter } from "@inboxzero/mail-core/protocol/routed-backend-adapter";
import { PUSHED_CHANGES_CATCH_UP_INTERVAL_MS } from "@/utils/mail-engine/follow-mailbox-changes";
import { createWorkerTextEmbedder } from "@/utils/mail-engine/embedding-worker-client";
import {
  createSemanticIndex,
  semanticSearchSupported,
} from "@/utils/mail-engine/semantic-index";

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
      opened: Promise<{ store: MailStore } | { error: unknown }>;
      nameOwnedAccounts: (accountIds: string[]) => void;
      abandon: () => void;
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
  event: MessageEvent<
    WorkerRequest | WorkerPreopenRequest | WorkerSessionResetRequest
  >,
) => {
  const message = event.data;
  if (message.type === "session_reset") {
    resetSessionGone();
    return;
  }
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
  const semantic = startSemanticIndex(store, input);
  const originalClose = created.close.bind(created);
  return {
    ...created,
    ensureAccount,
    ...(semantic && { searchSemantic: semantic.search }),
    async close() {
      semantic?.stop();
      // The loop stops first, so its turn neither waits out its deadline nor
      // fails against the closed store and pauses before noticing.
      await loop.stop();
      await originalClose();
    },
  };
}

// Nothing of the model loads here: its worker starts on the index's first
// batch or the first search. Devices it doesn't suit search as before.
function startSemanticIndex(store: MailStore, input: BrowserEngineStart) {
  if (!semanticSearchSupported(navigator, { touchOnly: input.touchOnly }))
    return null;
  const embedder = createWorkerTextEmbedder();
  const index = createSemanticIndex({
    store,
    embedder,
    startDelayMs: input.semanticIndexIntervalMs,
    recheckMs: input.semanticIndexIntervalMs,
  });
  index.start();
  return {
    search: index.search,
    stop() {
      index.stop();
      embedder.close();
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
  let abandon: () => void = () => undefined;
  const ownedAccountIds = new Promise<string[]>((resolve, reject) => {
    nameOwnedAccounts = resolve;
    abandon = () => reject(new Error("early mailbox open abandoned"));
  });
  // Unawaited by a mailbox with no work to carry.
  ownedAccountIds.catch(() => undefined);
  preopened = {
    maxPendingOperations: message.maxPendingOperations,
    opened: openStore({
      maxPendingOperations: message.maxPendingOperations,
      ownedAccountIds,
    }).then(
      (store) => ({ store }),
      (error: unknown) => ({ error }),
    ),
    nameOwnedAccounts,
    abandon,
  };
}

// A start that wants another mailbox than the one opened early opens its
// own, and the early open, never told the accounts, carries no work into a
// mailbox the start will not use. One whose early open met files a closing
// tab still held opens again; any other failure is the start's.
async function takePreopenedStore(input: BrowserEngineStart) {
  const early = preopened;
  preopened = undefined;
  if (!early) return null;
  if (
    input.persist === false ||
    early.maxPendingOperations !== input.maxPendingOperations
  ) {
    early.abandon();
    const opened = await early.opened;
    if ("store" in opened) await opened.store.close().catch(() => undefined);
    return null;
  }
  early.nameOwnedAccounts(input.ownedAccountIds);
  const opened = await early.opened;
  if ("store" in opened) return opened.store;
  if (classifyMailboxError(opened.error) === "busy") return null;
  throw opened.error;
}
