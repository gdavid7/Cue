import { SESSION_EXPIRED_ERROR_CODE } from "@/utils/config";
import {
  clearSessionExpired,
  isSessionExpiredErrorBody,
  isSessionExpiredRedirectArmed,
  notifySessionExpired,
  onSessionExpiredRedirectArmed,
} from "@/utils/session-expired";
import { isSigningOut } from "@/utils/signing-out";

// Skips the signed session-data cookie so the server re-reads the session
// row and re-issues that cookie, rather than answering from a stale copy.
const REFRESH_URL = "/api/auth/get-session?disableCookieCache=true";
// Requests of one burst can come back after the refresh settles; they reuse
// its answer rather than start another.
const REFRESH_REUSE_MS = 5000;
// Requests wait on the refresh, so one that hangs must not hold them all.
const REFRESH_TIMEOUT_MS = 10_000;
// Tabs tell each other when one is signed in. A stopped tab in the background
// may run the mailbox sync every tab reads from, so it checks at once rather
// than waiting to be shown.
const SESSION_CHANNEL = "cue-session";
const SIGNED_IN_MESSAGE = "signed-in";

let refresh: { promise: Promise<boolean>; settledAt?: number } | undefined;
// The server would not take this page's session even after a refresh. Each
// SWR revalidation, poll and mail sync would otherwise ask again and earn
// another 401, so nothing more is sent until the session is back.
let sessionGone = false;
// A check whose answer could not be had: the next request asks again.
let checkOnNextRequest = false;
let check: Promise<boolean> | undefined;
let stopWatchingForReturn: (() => void) | undefined;
const resetListeners = new Set<() => void>();

onSessionExpiredRedirectArmed(() => {
  announceSignedIn();
  if (sessionGone) startCheck();
});

/**
 * fetch() that answers a same-origin "session expired" 401 by refreshing the
 * session once and sending the request once more. Concurrent 401s share one
 * refresh.
 *
 * When the refresh finds no session, or the retry is rejected too, the
 * session is gone: the page is told once (notifySessionExpired), and from
 * then on same-origin requests are answered here with the same 401 instead of
 * being sent, so callers' sign-out handling runs as before. When the tab is
 * shown again, comes back online, or hears another tab is signed in, it asks
 * the server once whether the session is back. Public pages, where a 401 only
 * means signed out, never stop.
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
  const signal =
    init?.signal ?? (input instanceof Request ? input.signal : null);
  if (
    sameOrigin &&
    sessionGone &&
    !(await untilAborted(sessionCameBack(), signal))
  )
    return sessionExpiredResponse();
  const replayable = sameOrigin && canReplay(input, init);
  const response = await fetch(
    replayable && input instanceof Request ? input.clone() : input,
    init,
  );
  if (response.status !== 401 || !replayable) return response;
  // Sign-out ends the session on purpose; its 401s are not worth a refresh.
  if (isSigningOut()) return response;
  if (!(await isSessionExpiredResponse(response))) return response;
  if (!(await untilAborted(refreshSession(), signal))) return response;
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
        if (outcome === "refreshed") announceSignedIn();
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
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
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

/**
 * The server will not take this session. Also called by the page when the
 * mail engine's worker finds it gone, so the page stops too and its next
 * return to view checks once for both.
 */
export function markSessionGone() {
  notifySessionExpired();
  if (sessionGone) return;
  // On a page (not a worker), only one rendered for a signed-in user stops.
  if (typeof window !== "undefined" && !isSessionExpiredRedirectArmed()) return;
  sessionGone = true;
  stopWatchingForReturn = watchForReturn();
}

/**
 * The session is back: send requests again and take back any sign-in prompt.
 * Runs on its own when this page's check finds it; the mail engine's worker
 * is told by the page.
 */
export function resetSessionGone() {
  if (!sessionGone) return;
  sessionGone = false;
  refresh = undefined;
  checkOnNextRequest = false;
  stopWatchingForReturn?.();
  stopWatchingForReturn = undefined;
  clearSessionExpired();
  for (const listener of resetListeners) listener();
}

export function onSessionGoneReset(listener: () => void) {
  resetListeners.add(listener);
  return () => {
    resetListeners.delete(listener);
  };
}

/**
 * The mail engine's worker found the session gone. Its request may have left
 * before this page found the session back, so the page asks once (sharing a
 * refresh already under way) before stopping. Returns whether the worker
 * should send again.
 */
export async function workerFoundSessionGone() {
  if (!sessionGone && (await refreshSession())) return true;
  markSessionGone();
  return false;
}

function sessionCameBack(): Promise<boolean> {
  if (checkOnNextRequest) startCheck();
  return check ?? Promise.resolve(false);
}

// One check at a time; requests that arrive meanwhile wait on it.
function startCheck() {
  checkOnNextRequest = false;
  if (check) return;
  const current: Promise<boolean> = requestSessionRefresh()
    .then((outcome) => {
      if (outcome === "unknown") checkOnNextRequest = true;
      if (outcome !== "refreshed") return false;
      resetSessionGone();
      announceSignedIn();
      return true;
    })
    .finally(() => {
      if (check === current) check = undefined;
    });
  check = current;
}

// Capture listeners on the window run before SWR's own focus and visibility
// handlers, so the revalidation they start already waits on the check.
function watchForReturn() {
  if (typeof window === "undefined" || !window.addEventListener) return;
  const onReturn = (event: Event) => {
    if (event.type === "pageshow" && !(event as PageTransitionEvent).persisted)
      return;
    if (
      event.type !== "online" &&
      globalThis.document?.visibilityState === "hidden"
    )
      return;
    startCheck();
  };
  const events = ["visibilitychange", "focus", "pageshow", "online"];
  for (const type of events)
    window.addEventListener(type, onReturn, { capture: true });
  const channel =
    typeof BroadcastChannel === "undefined"
      ? undefined
      : new BroadcastChannel(SESSION_CHANNEL);
  if (channel) {
    channel.onmessage = (event) => {
      if (event.data === SIGNED_IN_MESSAGE) startCheck();
    };
    // Node's channel keeps a test run alive; browsers have no unref.
    (channel as { unref?: () => void }).unref?.();
  }
  return () => {
    for (const type of events)
      window.removeEventListener(type, onReturn, { capture: true });
    channel?.close();
  };
}

function announceSignedIn() {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined")
    return;
  const channel = new BroadcastChannel(SESSION_CHANNEL);
  channel.postMessage(SIGNED_IN_MESSAGE);
  channel.close();
}

// A caller that gives up (or a sign-out, through its signal) stops waiting on
// a refresh or check that other requests still share.
function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | null | undefined,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
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
