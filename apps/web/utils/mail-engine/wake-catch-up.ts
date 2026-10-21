// Shorter absences are covered by the engine's own catch-up, which runs as
// soon as the tab shows; the same line the server draws for a page load
// (`isLocalMailboxStale`).
const WAKE_AFTER_HIDDEN_MS = 15 * 60_000;
// Waited out after the tab shows, so flicking away and back is one wake, and
// a reconnect catch-up that finishes this quickly makes the read unnecessary.
const WAKE_SETTLE_MS = 2000;

/**
 * Runs `onWake` once when a tab that was hidden longer than the engine's
 * catch-up covers well is shown again, as after a laptop was asleep, if the
 * local mailbox is still behind (`isStale`) once the tab has settled. A tab
 * the browser kept running while hidden keeps syncing, so it is not stale
 * and asks for nothing. One catch-up runs at a time.
 */
export function followWakeCatchUp({
  isStale,
  onWake,
}: {
  isStale: () => boolean;
  onWake: () => Promise<unknown>;
}) {
  let hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let running = false;

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
      running = true;
      onWake()
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
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
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("pagehide", hide);
    window.removeEventListener("pageshow", onPageShow);
  };
}
