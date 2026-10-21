/** After the last of these, only the reader returning to the tab tries again. */
export const PUSH_SYNC_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];

/**
 * Runs a push subscription sync and, if it fails (no service worker in time,
 * a server error, a browser refusal), tries again on a short backoff and
 * whenever the reader comes back to the tab, until one succeeds. Without this
 * a failed resume after a pause leaves push off until the next page load.
 */
export function syncWithRetry({
  sync,
  onFailure,
}: {
  sync: () => Promise<boolean>;
  onFailure: (attempt: number) => void;
}) {
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let finished = false;

  const run = async () => {
    if (running || finished) return;
    running = true;
    clearTimeout(timer);
    const ok = await sync().catch(() => false);
    running = false;
    if (finished) return;
    if (ok) {
      stop();
      return;
    }
    onFailure(attempt);
    const delay = PUSH_SYNC_RETRY_DELAYS_MS[attempt];
    attempt += 1;
    if (delay !== undefined) timer = setTimeout(run, delay);
  };
  const onVisible = () => {
    if (document.visibilityState === "visible") run();
  };
  const stop = () => {
    finished = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("focus", run);
  };

  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("focus", run);
  run();
  return stop;
}
