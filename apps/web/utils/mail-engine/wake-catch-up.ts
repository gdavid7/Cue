import { createScopedLogger } from "@/utils/logger";

// Shorter absences are covered by the engine's own catch-up, which runs as
// soon as the tab shows; the same line the server draws for a page load
// (`isLocalMailboxStale`).
const WAKE_AFTER_HIDDEN_MS = 15 * 60_000;
// Waited out after the tab shows, so flicking away and back is one wake, and
// a reconnect catch-up that finishes this quickly makes the read unnecessary.
const WAKE_SETTLE_MS = 2000;
// A laptop that sleeps with the tab showing fires no visibility event on
// waking; a tick this often that finds the clock far ahead of it is one.
const WAKE_TICK_MS = 30_000;

const logger = createScopedLogger("mail-engine/wake-catch-up");

type WakeLocks = Pick<LockManager, "request">;

/**
 * Runs `onWake` once when a tab that was hidden longer than the engine's
 * catch-up covers well is shown again, or a showing tab's timers stopped that
 * long (a laptop asleep with it open, a frozen page), if the
 * local mailbox is still behind (`isStale`) once the tab has settled. A tab
 * the browser kept running while hidden keeps syncing, so it is not stale
 * and asks for nothing. One catch-up runs at a time, across this browser's
 * tabs too, since they share one engine; stopping aborts one in flight.
 */
export function followWakeCatchUp({
  accountId,
  isStale,
  onWake,
  locks = typeof navigator === "undefined" ? undefined : navigator.locks,
}: {
  accountId: string;
  isStale: () => boolean;
  onWake: (signal: AbortSignal) => Promise<unknown>;
  locks?: WakeLocks;
}) {
  let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let running: AbortController | null = null;
  let tick: ReturnType<typeof setInterval> | undefined;
  let tickedAt = Date.now();

  const run = () => {
    const abort = new AbortController();
    running = abort;
    // Another tab of this browser waking at the same time already reads it.
    // `ifAvailable` never waits, and browsers reject it alongside a signal;
    // the read itself takes the signal.
    const done = locks
      ? locks.request(
          wakeCatchUpLockName(accountId),
          { ifAvailable: true },
          (lock) => (lock ? onWake(abort.signal) : undefined),
        )
      : onWake(abort.signal);
    done
      .catch((error: unknown) => {
        if (!abort.signal.aborted)
          logger.warn("Wake catch-up failed", { error });
      })
      .finally(() => {
        if (running === abort) running = null;
      });
  };
  const stopTicking = () => {
    clearInterval(tick);
    tick = undefined;
  };
  const startTicking = () => {
    tickedAt = Date.now();
    if (tick === undefined) tick = setInterval(checkGap, WAKE_TICK_MS);
  };
  // Hidden, the tab's own absence counts instead, from when it was hidden.
  const checkGap = () => {
    if (document.visibilityState === "hidden") return;
    if (Date.now() - tickedAt >= WAKE_AFTER_HIDDEN_MS) hiddenAt ??= tickedAt;
    show();
  };
  const hide = () => {
    stopTicking();
    clearTimeout(settle);
    settle = undefined;
    // A wake still settling keeps its original absence.
    hiddenAt ??= Date.now();
  };
  const show = () => {
    startTicking();
    if (hiddenAt === null || settle !== undefined) return;
    if (Date.now() - hiddenAt < WAKE_AFTER_HIDDEN_MS) {
      hiddenAt = null;
      return;
    }
    settle = setTimeout(() => {
      settle = undefined;
      hiddenAt = null;
      if (running || !isStale()) return;
      run();
    }, WAKE_SETTLE_MS);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") hide();
    else show();
  };
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted && document.visibilityState !== "hidden") show();
  };

  if (document.visibilityState !== "hidden") startTicking();
  document.addEventListener("visibilitychange", onVisibilityChange);
  document.addEventListener("resume", checkGap);
  window.addEventListener("online", checkGap);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    stopTicking();
    clearTimeout(settle);
    running?.abort();
    running = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.removeEventListener("resume", checkGap);
    window.removeEventListener("online", checkGap);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", onPageShow);
  };
}

function wakeCatchUpLockName(accountId: string) {
  return `cue:wake-catch-up:${accountId}`;
}
