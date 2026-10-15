import type { MailEngine } from "@inboxzero/mail-core/engine";

const TURN_MS = 2000;
const IDLE_MS = 250;
const FAILED_TURN_PAUSE_MS = 1000;

/**
 * Runs the engine's work in short turns for as long as the engine is open.
 * Stopping cuts the current turn and pause short, so closing the engine, as
 * sign-out does before it wipes the mailbox, never waits out a turn.
 */
export function startEngineLoop(engine: Pick<MailEngine, "runUntil">) {
  const abort = new AbortController();
  const { signal } = abort;
  const done = (async () => {
    while (!signal.aborted) {
      try {
        await engine.runUntil(Date.now() + TURN_MS, signal);
      } catch {
        await pause(FAILED_TURN_PAUSE_MS, signal);
      }
      await pause(IDLE_MS, signal);
    }
  })();
  return {
    async stop() {
      // Safe mid-command: an aborted command is retried as not dispatched,
      // under the same operationId.
      abort.abort();
      await done;
    },
  };
}

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}
