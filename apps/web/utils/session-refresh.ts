import { isSessionExpiredErrorBody } from "@/utils/session-expired";

// Skips the signed session-data cookie so the server re-reads the session
// row and re-issues that cookie, rather than answering from a stale copy.
const REFRESH_URL = "/api/auth/get-session?disableCookieCache=true";
// Requests of one burst can come back after the refresh settles; they reuse
// its answer rather than start another.
const REFRESH_REUSE_MS = 5000;

let refresh: { promise: Promise<boolean>; settledAt?: number } | undefined;

/**
 * fetch() that answers a same-origin "session expired" 401 by refreshing the
 * session once and sending the request once more. When the refresh finds no
 * session, or the retry is rejected too, the 401 is returned unchanged so the
 * caller's sign-out handling runs as before.
 *
 * Writes are replayed too: the session-expired code is only sent by the auth
 * gate, which rejects a request before its handler runs, so nothing happened
 * that a replay could repeat. Any other 401 is returned as-is.
 */
export async function fetchWithSessionRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const replayable = isSameOrigin(input) && canReplay(input, init);
  const response = await fetch(
    replayable && input instanceof Request ? input.clone() : input,
    init,
  );
  if (response.status !== 401 || !replayable) return response;
  if (!(await isSessionExpiredResponse(response))) return response;
  if (!(await refreshSession())) return response;
  return fetch(input, init);
}

function refreshSession() {
  if (
    refresh &&
    (refresh.settledAt === undefined ||
      Date.now() - refresh.settledAt < REFRESH_REUSE_MS)
  )
    return refresh.promise;

  const current: { promise: Promise<boolean>; settledAt?: number } = {
    promise: requestSessionRefresh().finally(() => {
      current.settledAt = Date.now();
    }),
  };
  refresh = current;
  return current.promise;
}

async function requestSessionRefresh() {
  try {
    const response = await fetch(REFRESH_URL, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return !!body && typeof body === "object" && "user" in body && !!body.user;
  } catch {
    return false;
  }
}

async function isSessionExpiredResponse(response: Response) {
  try {
    return isSessionExpiredErrorBody(await response.clone().json());
  } catch {
    return false;
  }
}

function isSameOrigin(input: string | URL | Request) {
  const url = input instanceof Request ? input.url : input.toString();
  if (url.startsWith("/") && !url.startsWith("//")) return true;
  const origin = globalThis.location?.origin;
  if (!origin) return false;
  try {
    return new URL(url, origin).origin === origin;
  } catch {
    return false;
  }
}

// A stream is read by the first send, so a second send would go out empty.
function canReplay(input: string | URL | Request, init?: RequestInit) {
  if (init?.body instanceof ReadableStream) return false;
  if (init?.body === undefined && input instanceof Request)
    return !input.bodyUsed;
  return true;
}
