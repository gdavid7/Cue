const CLOSED_STREAM_RETRY_MS = 30_000;
// One stream per account. Browsers hold about six connections to a host over
// HTTP/1.1, and requests need the rest.
const MAX_FOLLOWED_ACCOUNTS = 4;
// While the stream is down, the tab that would hold it polls instead. Each
// sync request is one cheap history read that the engine coalesces with any
// already queued.
const DISCONNECTED_POLL_MS = 15_000;
// Switching back and forth between windows asks for one catch-up, not one per
// switch.
const SHOWN_SYNC_MIN_INTERVAL_MS = 5000;
// An open stream holds a server function open, so a visible tab nobody has
// touched for this long (a screen left on overnight) lets it go; the mail
// version poll covers it until the next input.
const USER_IDLE_MS = 5 * 60_000;
// EventSource.CLOSED, without depending on the global in non-browser runtimes.
const EVENT_SOURCE_CLOSED = 2;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

/**
 * How often the browser engine reads changes nobody asked for. Provider
 * pushes reach it as sync requests, from the stream while someone is looking
 * and from the mail version poll otherwise, so this only catches a push that
 * never came.
 */
export const PUSHED_CHANGES_CATCH_UP_INTERVAL_MS = 5 * 60_000;

/** Held by the one tab in this browser that streams an account's changes. */
export function mailStreamLockName(accountId: string) {
  return `cue:mail-stream:${accountId}`;
}

type StreamLocks = Pick<LockManager, "request">;

/**
 * Requests a sync when the server reports a provider change, so new mail
 * shows up without waiting for the engine's idle catch-up. Only a visible tab
 * someone is using streams, and only one per browser for each account: tabs
 * share one engine, so a second stream would only repeat the first. Hidden
 * and idle tabs drop the connection and catch up as soon as they are shown,
 * focused or used again. `onTrackersChange` hears that Cue changed what needs
 * a reply.
 */
export function followMailboxChanges({
  accountId,
  onChange,
  onTrackersChange,
  createEventSource = (url) => new EventSource(url),
  locks = typeof navigator === "undefined" ? undefined : navigator.locks,
}: {
  accountId: string;
  onChange: () => void;
  onTrackersChange?: () => void;
  createEventSource?: (url: string) => EventSource;
  locks?: StreamLocks;
}) {
  const url = `/api/mail-stream?emailAccountId=${encodeURIComponent(accountId)}`;
  let source: EventSource | null = null;
  let connected = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastShownSyncAt = Number.NEGATIVE_INFINITY;
  let lastInputAt = Date.now();
  // Leading: this tab holds the account's stream lock (or there are no locks).
  let leading = false;
  let waiting: AbortController | null = null;
  let releaseLock: (() => void) | null = null;

  const engaged = () =>
    document.visibilityState !== "hidden" &&
    Date.now() - lastInputAt < USER_IDLE_MS;

  const open = () => {
    if (source || !leading || !engaged()) return;
    const opened = createEventSource(url);
    source = opened;
    opened.addEventListener("mailbox-change", onChange);
    if (onTrackersChange)
      opened.addEventListener("trackers-change", onTrackersChange);
    // Every (re)connect sends `ready`; changes while disconnected are not
    // replayed, so catch up then.
    opened.addEventListener("ready", () => {
      if (source === opened) connected = true;
      onChange();
    });
    opened.addEventListener("error", () => {
      if (source !== opened) return;
      connected = false;
      // EventSource retries dropped connections itself but gives up on an
      // error response, which would otherwise leave this tab without updates.
      if (opened.readyState !== EVENT_SOURCE_CLOSED) return;
      source = null;
      clearTimeout(retry);
      retry = setTimeout(open, CLOSED_STREAM_RETRY_MS);
    });
  };
  const closeStream = () => {
    clearTimeout(retry);
    source?.close();
    source = null;
    connected = false;
  };
  const lead = () => {
    if (leading || waiting || !engaged()) return;
    if (!locks) {
      leading = true;
      open();
      return;
    }
    const request = new AbortController();
    waiting = request;
    locks
      .request(
        mailStreamLockName(accountId),
        { signal: request.signal },
        () => {
          // Granted just as this tab stepped down or stopped: pass it on.
          if (waiting !== request) return;
          waiting = null;
          leading = true;
          return new Promise<void>((release) => {
            releaseLock = release;
            open();
          });
        },
      )
      .catch(() => {
        // Aborted while another tab held it.
      });
  };
  const stepDown = () => {
    waiting?.abort();
    waiting = null;
    leading = false;
    closeStream();
    releaseLock?.();
    releaseLock = null;
  };
  const syncShown = () => {
    const now = Date.now();
    if (now - lastShownSyncAt < SHOWN_SYNC_MIN_INTERVAL_MS) return;
    lastShownSyncAt = now;
    onChange();
  };
  const resume = () => {
    lastInputAt = Date.now();
    lead();
    // The stream's `ready` catches up too, but only once it connects; a
    // broken stream would leave the shown tab stale until a poll.
    syncShown();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      stepDown();
      return;
    }
    resume();
  };
  const onFocus = () => {
    if (document.visibilityState !== "hidden") resume();
  };
  const onActivity = () => {
    const wasIdle = !engaged();
    lastInputAt = Date.now();
    if (wasIdle && document.visibilityState !== "hidden") resume();
  };
  const tick = setInterval(() => {
    if (!engaged()) {
      stepDown();
      return;
    }
    if (leading && !connected) onChange();
  }, DISCONNECTED_POLL_MS);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocus);
  for (const type of ACTIVITY_EVENTS)
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  lead();
  return () => {
    clearInterval(tick);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onFocus);
    for (const type of ACTIVITY_EVENTS)
      window.removeEventListener(type, onActivity, { capture: true });
    stepDown();
  };
}

/**
 * The accounts whose new mail should show at once: the open one, and, while
 * the user looks at all their accounts together (All inboxes, Today across
 * accounts), every account those show. Each stream holds a server function
 * open, so one account's pages follow that account only; the others catch
 * up on the mail version poll.
 */
export function getFollowedAccountIds(
  emailAccountId: string,
  allInboxesAccountIds: string[],
  allAccounts: boolean,
) {
  const others =
    allAccounts && allInboxesAccountIds.length > 1
      ? allInboxesAccountIds.filter((id) => id !== emailAccountId)
      : [];
  return [emailAccountId, ...others].slice(0, MAX_FOLLOWED_ACCOUNTS);
}
