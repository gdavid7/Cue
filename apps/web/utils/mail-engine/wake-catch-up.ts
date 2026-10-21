import { createScopedLogger } from "@/utils/logger";

// Shorter absences are covered by the engine's own catch-up, which runs as
// soon as the tab shows; the same line the server draws for a page load
// (`isLocalMailboxStale`).
const WAKE_AFTER_HIDDEN_MS = 15 * 60_000;
// Waited out after the tab shows, so flicking away and back is one wake, and
// a reconnect catch-up that finishes this quickly makes the read unnecessary.
const WAKE_SETTLE_MS = 2000;

const logger = createScopedLogger("mail-engine/wake-catch-up");

type WakeLocks = Pick<LockManager, "request">;

/**
 * Runs `onWake` once when a tab that was hidden longer than the engine's
 * catch-up covers well is shown again, as after a laptop was asleep, if the
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
  const hide = () => {
    clearTimeout(settle);
    settle = undefined;
    // A wake still settling keeps its original absence.
    hiddenAt ??= Date.now();
  };
  const show = () => {
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

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("pagehide", hide);
  window.addEventListener("pageshow", onPageShow);
  return () => {
    clearTimeout(settle);
    running?.abort();
    running = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", onPageShow);
  };
}

function wakeCatchUpLockName(accountId: string) {
  return `cue:wake-catch-up:${accountId}`;
}
