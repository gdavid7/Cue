import { describeMailEngineCapabilities } from "@inboxzero/mail-core/capabilities";
import type { MailEngine } from "@inboxzero/mail-core/engine";
import type { QuerySnapshot } from "@inboxzero/mail-core/queries";
import {
  observeByKind,
  unsupportedMethodMessage,
  workerStartFence,
  type BrowserEngineStart,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerStarted,
} from "./worker-protocol";

export function createMailWorkerHost(hooks: {
  createEngine: (input: BrowserEngineStart) => Promise<MailEngine>;
  post: (message: WorkerResponse) => void;
}) {
  const handles = new Map<
    string,
    { close: () => void; loadMore?: () => Promise<void> }
  >();
  let engine: MailEngine | undefined;
  let startedAccount: string | undefined;
  let startQueue = Promise.resolve();
  // One write refreshes every open view. Sending their snapshots together
  // lets the page render the change once instead of once per view.
  const queuedSnapshots = new Map<string, QuerySnapshot<unknown>>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  function queueSnapshot(handleId: string, snapshot: QuerySnapshot<unknown>) {
    queuedSnapshots.set(handleId, snapshot);
    flushTimer ??= setTimeout(flushSnapshots, 0);
  }

  function flushSnapshots() {
    clearTimeout(flushTimer);
    flushTimer = undefined;
    if (queuedSnapshots.size === 0) return;
    const snapshots = [...queuedSnapshots].map(([handleId, snapshot]) => ({
      handleId,
      snapshot,
    }));
    queuedSnapshots.clear();
    hooks.post({ type: "snapshots", snapshots });
  }

  // Views are current by the time a call settles, as they were when each
  // snapshot went out on its own.
  function respond(message: WorkerResponse) {
    flushSnapshots();
    hooks.post(message);
  }

  async function handle(message: WorkerRequest) {
    try {
      if (message.type === "start") {
        const run = startQueue.then(() => start(message));
        startQueue = run.then(
          () => undefined,
          () => undefined,
        );
        await run;
        return;
      }
      if (!engine) {
        respond({
          id: message.id,
          type: "error",
          message: "engine not started",
        });
        return;
      }
      if (message.type === "close") {
        for (const item of handles.values()) item.close();
        handles.clear();
        queuedSnapshots.clear();
        await engine.close();
        engine = undefined;
        startedAccount = undefined;
        respond({ id: message.id, type: "ok" });
        return;
      }
      if (message.type === "loadMore") {
        const handle = handles.get(message.handleId);
        if (!handle?.loadMore) throw new Error("Mailbox window is unavailable");
        await handle.loadMore();
        respond({ id: message.id, type: "ok" });
        return;
      }
      if (message.type === "unobserve") {
        handles.get(message.handleId)?.close();
        handles.delete(message.handleId);
        queuedSnapshots.delete(message.handleId);
        respond({ id: message.id, type: "ok" });
        return;
      }
      if (message.type === "observe") {
        const observed = observeByKind(engine, message.kind, message.args);
        handles.set(message.handleId, observed);
        observed.subscribe(() => {
          queueSnapshot(message.handleId, observed.getSnapshot());
        });
        queueSnapshot(message.handleId, observed.getSnapshot());
        respond({ id: message.id, type: "ok" });
        return;
      }
      const method = engine[message.method as keyof MailEngine];
      if (typeof method !== "function") {
        respond({
          id: message.id,
          type: "error",
          message: unsupportedMethodMessage(message.method),
        });
        return;
      }
      const value = await (
        method as (...args: unknown[]) => Promise<unknown>
      ).apply(engine, message.args);
      respond({ id: message.id, type: "ok", value });
    } catch (error) {
      respond({
        id: "id" in message ? message.id : "worker",
        type: "error",
        message: error instanceof Error ? error.message : "worker_error",
      });
    }
  }

  async function start(message: Extract<WorkerRequest, { type: "start" }>) {
    const fence = workerStartFence(startedAccount, message.input.accountId);
    if (fence) {
      respond({
        id: message.id,
        type: "error",
        message: fence,
      });
      return;
    }
    if (engine) {
      respond({ id: message.id, type: "ok", value: started(engine) });
      return;
    }
    startedAccount = message.input.accountId;
    try {
      engine = await hooks.createEngine(message.input);
    } catch (error) {
      startedAccount = undefined;
      throw error;
    }
    respond({ id: message.id, type: "ok", value: started(engine) });
  }

  return { handle };
}

function started(engine: MailEngine): WorkerStarted {
  return { capabilities: describeMailEngineCapabilities(engine) };
}
