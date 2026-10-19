import { scheduleAfterPageLoad } from "@/utils/schedule-after-page-load";

/**
 * Work that can wait (warming the composer, background checks) waits for the
 * mail screen to show its first list from the mail engine, so it never
 * competes with the engine opening, syncing and catching up on new mail. A
 * page that never shows one, such as Settings, runs it after a short wait,
 * and nothing waits longer than the cap, however the page is loading.
 */

const FALLBACK_MS = 5000;
// The engine catches up on mail that arrived while Cue was closed right
// after its first list, so deferred work leaves it this long first.
const SETTLE_MS = 2500;
// The page's load event can be held up indefinitely by a slow resource.
const CAP_MS = 10_000;

// Background reads that compete with sync (inbox insights) also wait for the
// engine to catch up on what arrived while Cue was closed, up to this long
// after the first list; a backlog that takes longer still gets them.
const CAUGHT_UP_CAP_MS = 30_000;

let shown = false;
const waiters = new Set<() => void>();
let caughtUp = false;
const caughtUpWaiters = new Set<() => void>();

export function markFirstMailListShown() {
  if (shown) return;
  shown = true;
  for (const waiter of [...waiters]) waiter();
  waiters.clear();
}

export function afterFirstMailList(
  callback: () => void,
  {
    fallbackMs = FALLBACK_MS,
    settleMs = SETTLE_MS,
    capMs = CAP_MS,
  }: { fallbackMs?: number; settleMs?: number; capMs?: number } = {},
) {
  let done = false;
  let cancelIdle: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (done) return;
    done = true;
    cancel();
    callback();
  };
  const runWhenIdle = () => {
    cancelIdle ??= scheduleAfterPageLoad(run, {
      fallbackDelay: 1000,
      idleTimeout: 3000,
    });
  };
  const start = () => {
    waiters.delete(start);
    if (timeout !== undefined) clearTimeout(timeout);
    timeout = setTimeout(runWhenIdle, settleMs);
  };
  const cap = setTimeout(run, capMs);
  function cancel() {
    waiters.delete(start);
    if (timeout !== undefined) clearTimeout(timeout);
    clearTimeout(cap);
    cancelIdle?.();
  }
  if (shown) start();
  else {
    waiters.add(start);
    timeout = setTimeout(runWhenIdle, fallbackMs);
  }
  return () => {
    done = true;
    cancel();
  };
}

/** The engine finished a catch-up round since this page opened. */
export function markMailCaughtUp() {
  if (caughtUp) return;
  caughtUp = true;
  for (const waiter of [...caughtUpWaiters]) waiter();
  caughtUpWaiters.clear();
}

/**
 * Like `afterFirstMailList`, and then also after the engine has caught up,
 * or `capMs` after the first list, whichever comes first.
 */
export function afterMailCaughtUp(
  callback: () => void,
  { capMs = CAUGHT_UP_CAP_MS }: { capMs?: number } = {},
) {
  let cap: ReturnType<typeof setTimeout> | undefined;
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    caughtUpWaiters.delete(run);
    clearTimeout(cap);
    callback();
  };
  const cancelFirstList = afterFirstMailList(() => {
    if (caughtUp) return run();
    caughtUpWaiters.add(run);
    cap = setTimeout(run, capMs);
  });
  return () => {
    done = true;
    cancelFirstList();
    caughtUpWaiters.delete(run);
    clearTimeout(cap);
  };
}

export function resetFirstMailListForTesting() {
  shown = false;
  waiters.clear();
  caughtUp = false;
  caughtUpWaiters.clear();
}
