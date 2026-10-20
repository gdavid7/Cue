/**
 * Which accounts this browser holds a synced local mailbox for, and when each
 * last finished a sync, so the server knows when a visit needs the inbox's
 * newest mail from the provider: a first visit, or a return after the local
 * mailbox has fallen behind. It only carries account ids the signed-in user
 * owns; the server still resolves the account from the session.
 */
export const LOCAL_MAILBOX_COOKIE = "cue-local-mail";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;
// A mailbox that synced this recently catches up in one short read on open;
// past it, the newest inbox mail is fetched for the page while it does.
const STALE_AFTER_MS = 15 * 60_000;
// The time is rewritten at most this often while Cue stays open.
const REWRITE_EVERY_MS = 60_000;
// Times are written on the server's clock, so one further ahead than this
// came from a browser whose clock was off and isn't trusted.
const FUTURE_SLACK_MS = 5 * 60_000;
const SYNCED_AT_SEPARATOR = "~";

/**
 * When the browser's local mailbox for the account last finished a sync, in
 * epoch ms: 0 when it has one but the time is unknown, null when it has none.
 */
export function localMailboxSyncedAt(
  cookieValue: string | undefined,
  accountId: string,
): number | null {
  return readEntries(cookieValue).get(accountId) ?? null;
}

export function hasLocalMailbox(
  cookieValue: string | undefined,
  accountId: string,
) {
  return localMailboxSyncedAt(cookieValue, accountId) !== null;
}

export function isLocalMailboxStale(syncedAtMs: number, nowMs = Date.now()) {
  if (syncedAtMs > nowMs + FUTURE_SLACK_MS) return true;
  return nowMs - syncedAtMs > STALE_AFTER_MS;
}

/**
 * `syncedAtMs` is when its last sync finished, if one has, on the server's
 * clock (see `useServerClockOffset`), which is what the server compares it
 * with.
 */
export function markLocalMailboxSynced(
  accountId: string,
  syncedAtMs: number | null = null,
) {
  const entries = readEntries(readCookie());
  const recorded = entries.get(accountId);
  const at = syncedAtMs ?? 0;
  // A time recorded ahead of this sync came from a clock that was off; this
  // one replaces it rather than waiting for the clock to catch up.
  const recordedAhead =
    recorded !== undefined && at > 0 && recorded > at + FUTURE_SLACK_MS;
  if (
    recorded !== undefined &&
    !recordedAhead &&
    at - recorded < REWRITE_EVERY_MS
  )
    return;
  entries.set(accountId, recordedAhead ? at : Math.max(at, recorded ?? 0));
  writeEntries(entries);
}

/** Part of removing one account's mail from this browser. */
export function forgetLocalMailbox(accountId: string) {
  const entries = readEntries(readCookie());
  if (!entries.delete(accountId)) return;
  writeEntries(entries);
}

/** In the browser: whether it holds a synced mailbox for the account. */
export function isLocalMailboxMarked(accountId: string) {
  return hasLocalMailbox(readCookie(), accountId);
}

/** Part of wiping the local mailbox, on sign-out. */
export function clearLocalMailboxCookie() {
  writeCookie("", 0);
}

// Account ids are cuids, safe in a cookie as they are, so the value is never
// percent-encoding: decoding it here again would throw on a stray "%". An
// entry from before times were kept is an account with an unknown time.
function readEntries(cookieValue: string | undefined) {
  const entries = new Map<string, number>();
  for (const entry of cookieValue ? cookieValue.split(".") : []) {
    const [id, time] = entry.split(SYNCED_AT_SEPARATOR);
    if (!id) continue;
    const seconds = time ? Number.parseInt(time, 36) : 0;
    entries.set(id, Number.isFinite(seconds) ? seconds * 1000 : 0);
  }
  return entries;
}

function writeEntries(entries: Map<string, number>) {
  writeCookie(
    [...entries]
      .map(([id, time]) =>
        time
          ? `${id}${SYNCED_AT_SEPARATOR}${Math.floor(time / 1000).toString(36)}`
          : id,
      )
      .join("."),
    MAX_AGE_SECONDS,
  );
}

function readCookie() {
  if (typeof document === "undefined") return;
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LOCAL_MAILBOX_COOKIE}=`))
    ?.slice(LOCAL_MAILBOX_COOKIE.length + 1);
}

function writeCookie(value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCAL_MAILBOX_COOKIE}=${value}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
