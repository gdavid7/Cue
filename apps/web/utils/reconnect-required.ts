import {
  MICROSOFT_AUTH_EXPIRED_ERROR_CODE,
  NO_REFRESH_TOKEN_ERROR_CODE,
  RECONNECT_REQUIRED_MESSAGE,
} from "@/utils/config";

// A page left open on a revoked account would otherwise ask the server on
// every poll. After this long it asks once more, so an account reconnected in
// another tab or window is picked up without a reload. Only the routes the
// server refused are held back: others, such as settings, work without the
// mailbox grant.
const RECHECK_AFTER_MS = 5 * 60_000;

const checkedAgainAt = new Map<string, number>();

// Coming back to the tab is when a reconnect done in another one is most
// likely. The mail engine's worker has no page to watch, so there the
// RECHECK_AFTER_MS window is all there is.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") checkedAgainAt.clear();
  });
}

export function isReconnectRequiredBody(body: unknown) {
  if (!body || typeof body !== "object" || !("errorCode" in body)) return false;
  return (
    body.errorCode === NO_REFRESH_TOKEN_ERROR_CODE ||
    body.errorCode === MICROSOFT_AUTH_EXPIRED_ERROR_CODE
  );
}

export function noteReconnectRequired(emailAccountId: string, url: string) {
  checkedAgainAt.set(
    refusalKey(emailAccountId, url),
    Date.now() + RECHECK_AFTER_MS,
  );
}

export function isReconnectRequired(emailAccountId: string, url: string) {
  const key = refusalKey(emailAccountId, url);
  const until = checkedAgainAt.get(key);
  if (until === undefined) return false;
  if (Date.now() < until) return true;
  checkedAgainAt.delete(key);
  return false;
}

/** What the server answers, for a request the page already knows it would refuse. */
export function reconnectRequiredBody() {
  return {
    error: RECONNECT_REQUIRED_MESSAGE,
    errorCode: NO_REFRESH_TOKEN_ERROR_CODE,
    isKnownError: true,
  };
}

function refusalKey(emailAccountId: string, url: string) {
  let pathname = url;
  try {
    pathname = new URL(url, "http://localhost").pathname;
  } catch {
    // Keep the raw url.
  }
  return `${emailAccountId} ${pathname}`;
}
