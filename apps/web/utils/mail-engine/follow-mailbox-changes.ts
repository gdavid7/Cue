const CLOSED_STREAM_RETRY_MS = 30_000;
// One stream per account. Browsers hold about six connections to a host over
// HTTP/1.1, and requests need the rest.
const MAX_FOLLOWED_ACCOUNTS = 4;
// While the stream is down, a visible tab polls instead. Each sync request is
// one cheap history read that the engine coalesces with any already queued.
const DISCONNECTED_POLL_MS = 15_000;
// Switching back and forth between windows asks for one catch-up, not one per
// switch.
const SHOWN_SYNC_MIN_INTERVAL_MS = 5000;
// EventSource.CLOSED, without depending on the global in non-browser runtimes.
const EVENT_SOURCE_CLOSED = 2;

/**
 * Requests a sync when the server reports a provider change, so new mail
 * shows up without waiting for the engine's idle catch-up. Hidden tabs drop
 * the connection and catch up as soon as they are shown or focused again.
 * `onTrackersChange` hears that Cue changed what needs a reply.
 */
export function followMailboxChanges({
  accountId,
  onChange,
  onTrackersChange,
  createEventSource = (url) => new EventSource(url),
}: {
  accountId: string;
  onChange: () => void;
  onTrackersChange?: () => void;
  createEventSource?: (url: string) => EventSource;
}) {
  const url = `/api/mail-stream?emailAccountId=${encodeURIComponent(accountId)}`;
  let source: EventSource | null = null;
  let connected = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let lastShownSyncAt = Number.NEGATIVE_INFINITY;

  const open = () => {
    if (source || document.visibilityState === "hidden") return;
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
  const close = () => {
    clearTimeout(retry);
    source?.close();
    source = null;
    connected = false;
  };
  const syncShown = () => {
    const now = Date.now();
    if (now - lastShownSyncAt < SHOWN_SYNC_MIN_INTERVAL_MS) return;
    lastShownSyncAt = now;
    onChange();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "hidden") {
      close();
      return;
    }
    open();
    // The reconnect's `ready` catches up too, but only once the stream
    // connects; a broken stream would leave the shown tab stale until a poll.
    syncShown();
  };
  const onFocus = () => {
    if (document.visibilityState !== "hidden") syncShown();
  };
  const poll = setInterval(() => {
    if (!connected && document.visibilityState !== "hidden") onChange();
  }, DISCONNECTED_POLL_MS);

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("focus", onFocus);
  open();
  return () => {
    clearInterval(poll);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    window.removeEventListener("focus", onFocus);
    close();
  };
}

/**
 * The accounts whose new mail should show at once: the open one, and, while
 * the user keeps two or more in All inboxes, those too, since All inboxes
 * and Today show them. Others catch up on the engine's idle sync.
 */
export function getFollowedAccountIds(
  emailAccountId: string,
  allInboxesAccountIds: string[],
) {
  const others =
    allInboxesAccountIds.length > 1
      ? allInboxesAccountIds.filter((id) => id !== emailAccountId)
      : [];
  return [emailAccountId, ...others].slice(0, MAX_FOLLOWED_ACCOUNTS);
}
