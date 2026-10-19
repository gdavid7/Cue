import { scheduleAfterPageLoad } from "@/utils/schedule-after-page-load";

/**
 * Work that can wait (warming the composer, background checks) waits for the
 * mail screen to show its first list from the mail engine, so it never
 * competes with the engine opening, syncing and catching up on new mail. A
 * page that never shows one, such as Settings, runs it after a short wait.
 */

const FALLBACK_MS = 5000;
// The engine catches up on mail that arrived while Cue was closed right
// after its first list, so deferred work leaves it this long first.
const SETTLE_MS = 2500;

let shown = false;
const waiters = new Set<() => void>();

export function markFirstMailListShown() {
  if (shown) return;
  shown = true;
  for (const waiter of [...waiters]) waiter();
  waiters.clear();
}

export function afterFirstMailList(
  callback: () => void,
  { fallbackMs = FALLBACK_MS }: { fallbackMs?: number } = {},
) {
  let cancelIdle: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const runWhenIdle = () => {
    cancelIdle ??= scheduleAfterPageLoad(callback, {
      fallbackDelay: 1000,
      idleTimeout: 3000,
    });
  };
  const start = () => {
    waiters.delete(start);
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(runWhenIdle, SETTLE_MS);
  };
  if (shown) start();
  else {
    waiters.add(start);
    timeout = setTimeout(runWhenIdle, fallbackMs);
  }
  return () => {
    waiters.delete(start);
    if (timeout !== undefined) clearTimeout(timeout);
    cancelIdle?.();
  };
}

export function resetFirstMailListForTesting() {
  shown = false;
  waiters.clear();
}
