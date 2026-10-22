import { SESSION_EXPIRED_ERROR_CODE } from "@/utils/config";
import {
  isSessionExpiredErrorBody,
  notifySessionExpired,
} from "@/utils/session-expired";
import { isSigningOut } from "@/utils/signing-out";

// Skips the signed session-data cookie so the server re-reads the session
// row and re-issues that cookie, rather than answering from a stale copy.
const REFRESH_URL = "/api/auth/get-session?disableCookieCache=true";
// Requests of one burst can come back after the refresh settles; they reuse
// its answer rather than start another.
const REFRESH_REUSE_MS = 5000;

let refresh: { promise: Promise<boolean>; settledAt?: number } | undefined;
// The server would not take this page's session even after a refresh. Each
// SWR revalidation, poll and mail sync would otherwise ask again and earn
// another 401, so nothing more is sent until the page loads again.
let sessionGone = false;

/**
 * fetch() that answers a same-origin "session expired" 401 by refreshing the
 * session once and sending the request once more. Concurrent 401s share one
 * refresh.
 *
 * When the refresh finds no session, or the retry is rejected too, the
 * session is gone: the page is told once (notifySessionExpired), and from
 * then on same-origin requests are answered here with the same 401 instead of
 * being sent, so callers' sign-out handling runs as before.
 *
 * Writes are replayed too: the session-expired code is only sent by the auth
 * gate, which rejects a request before its handler runs, so nothing happened
 * that a replay could repeat. Any other 401 is returned as-is.
 */
export async function fetchWithSessionRetry(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const sameOrigin = isSameOrigin(input);
  if (sameOrigin && sessionGone) return sessionExpiredResponse();
  const replayable = sameOrigin && canReplay(input, init);
  const response = await fetch(
    replayable && input instanceof Request ? input.clone() : input,
    init,
  );
  if (response.status !== 401 || !replayable) return response;
  // Sign-out ends the session on purpose; its 401s are not worth a refresh.
  if (isSigningOut()) return response;
  if (!(await isSessionExpiredResponse(response))) return response;
  if (!(await refreshSession())) return response;
  const retried = await fetch(input, init);
  if (retried.status === 401 && (await isSessionExpiredResponse(retried)))
    markSessionGone();
  return retried;
}

function refreshSession() {
  if (
    refresh &&
    (refresh.settledAt === undefined ||
      Date.now() - refresh.settledAt < REFRESH_REUSE_MS)
  )
    return refresh.promise;

  const current: { promise: Promise<boolean>; settledAt?: number } = {
    promise: requestSessionRefresh()
      .then((outcome) => {
        if (outcome === "signed-out") markSessionGone();
        return outcome === "refreshed";
      })
      .finally(() => {
        current.settledAt = Date.now();
      }),
  };
  refresh = current;
  return current.promise;
}

// Only an answer that names no user means signed out; a failed or erroring
// refresh says nothing about the session, so the page keeps trying.
async function requestSessionRefresh(): Promise<
  "refreshed" | "signed-out" | "unknown"
> {
  try {
    const response = await fetch(REFRESH_URL, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (response.status === 401) return "signed-out";
    if (!response.ok) return "unknown";
    const body: unknown = await response.json();
    const signedIn =
      !!body && typeof body === "object" && "user" in body && !!body.user;
    return signedIn ? "refreshed" : "signed-out";
  } catch {
    return "unknown";
  }
}

function markSessionGone() {
  if (sessionGone) return;
  sessionGone = true;
  // A page restored from the back/forward cache may be signed in again by
  // then; its next 401 is worth one more refresh.
  if (typeof window !== "undefined")
    window.addEventListener?.(
      "pageshow",
      (event: Event) => {
        if ((event as PageTransitionEvent).persisted) {
          sessionGone = false;
          refresh = undefined;
        }
      },
      { once: true },
    );
  notifySessionExpired();
}

function sessionExpiredResponse() {
  return Response.json(
    {
      error: "Unauthorized",
      errorCode: SESSION_EXPIRED_ERROR_CODE,
      isKnownError: true,
    },
    { status: 401 },
  );
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
