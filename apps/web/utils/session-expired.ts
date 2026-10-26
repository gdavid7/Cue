import { SESSION_EXPIRED_ERROR_CODE } from "@/utils/config";
import { isSigningOut } from "@/utils/signing-out";
import { buildLoginRedirectUrl, redirectToSafeUrl } from "@/utils/redirect";

// Server actions answer a missing session with this text, which is how the
// client tells it apart from other action errors. The client also shows it
// for a session-expired API 401 and in the composer's sign-in toast.
export const SESSION_EXPIRED_MESSAGE = "Session expired. Please sign in again.";

const REDIRECTED_AT_KEY = "session-expired-redirected-at";
// Covers a login page that bounces straight back with a session the server
// still rejects, without blocking a real expiry later in the same tab.
const REPEAT_REDIRECT_WINDOW_MS = 10_000;

type SessionExpiredHold = {
  /** Asks the user to sign in; `signIn` saves first, then redirects. */
  prompt: (signIn: () => void) => void;
  /** Saves what the user typed before the page leaves. */
  beforeRedirect: () => Promise<unknown>;
  /** Takes the prompt back when the session turns out to be live again. */
  dismiss?: () => void;
};

let state: "active" | "held" | "redirected" = "active";
let armedBy = 0;
let armedUserId: string | undefined;
let leftForOtherUser = false;
const holds = new Set<SessionExpiredHold>();
const armedListeners = new Set<() => void>();

export function isSessionExpiredErrorBody(body: unknown) {
  return (
    !!body &&
    typeof body === "object" &&
    "errorCode" in body &&
    body.errorCode === SESSION_EXPIRED_ERROR_CODE
  );
}

/**
 * Marks the page as one rendered for a signed-in user. Public pages read the
 * session too, and a 401 there only means "signed out", so they must never be
 * sent to log in.
 */
export function armSessionExpiredRedirect(userId?: string) {
  if (userId) armedUserId = userId;
  armedBy += 1;
  if (armedBy === 1) for (const listener of armedListeners) listener();
  return () => {
    armedBy -= 1;
    // A public page must never act for the user who was signed in.
    if (armedBy === 0) armedUserId = undefined;
  };
}

export function isSessionExpiredRedirectArmed() {
  return armedBy > 0;
}

/** The user this page was rendered for, once a signed-in page armed it. */
export function getArmedUserId() {
  return armedUserId;
}

/**
 * Someone else signed in on this browser. Nothing on this page is theirs, not
 * even the draft a composer would save, so it leaves without saving or
 * asking.
 */
export function leaveForOtherUser() {
  if (typeof window === "undefined" || leftForOtherUser) return;
  leftForOtherUser = true;
  state = "redirected";
  for (const hold of holds) hold.dismiss?.();
  redirectToSafeUrl("/");
}

/** A page for a signed-in user has just rendered. */
export function onSessionExpiredRedirectArmed(listener: () => void) {
  armedListeners.add(listener);
  return () => {
    armedListeners.delete(listener);
  };
}

/**
 * The session is live again: take back a sign-in prompt still waiting, so a
 * composer closing later does not send a signed-in user to log in, and let a
 * later expiry be noticed.
 */
export function clearSessionExpired() {
  if (leftForOtherUser) return;
  if (state === "held") for (const hold of holds) hold.dismiss?.();
  state = "active";
}

/**
 * Sends a signed-out browser to log in once, however many requests notice.
 * While a composer is open it asks through that composer's prompt instead, so
 * a redirect never takes the page out from under someone typing.
 */
export function notifySessionExpired() {
  if (
    typeof window === "undefined" ||
    armedBy === 0 ||
    state !== "active" ||
    isSigningOut()
  )
    return;
  if (holds.size === 0) {
    redirectToLogin();
    return;
  }
  state = "held";
  for (const hold of holds) {
    hold.prompt(() => {
      hold.beforeRedirect().finally(redirectToLogin);
    });
  }
}

/**
 * Keeps a session-expired redirect from firing while the caller is mounted.
 * If the redirect is waiting when the last hold goes away, the caller's work
 * is saved first.
 */
export function holdSessionExpiredRedirect(hold: SessionExpiredHold) {
  holds.add(hold);
  return () => {
    holds.delete(hold);
    if (state === "held" && holds.size === 0)
      hold.beforeRedirect().finally(redirectToLogin);
  };
}

/** Whether an open composer would lose what is being typed if the page left. */
export function hasSessionExpiredHold() {
  return holds.size > 0;
}

/** Saves what every open composer holds, then leaves. */
export function saveHeldWorkThen(leave: () => void) {
  if (holds.size === 0) {
    leave();
    return;
  }
  Promise.allSettled([...holds].map((hold) => hold.beforeRedirect())).finally(
    leave,
  );
}

function redirectToLogin() {
  if (state === "redirected") return;
  state = "redirected";
  if (redirectedRecently()) return;
  try {
    window.sessionStorage.setItem(REDIRECTED_AT_KEY, String(Date.now()));
  } catch {
    // Without storage the loop guard is off; redirecting is still right.
  }
  const { pathname, search, hash } = window.location;
  redirectToSafeUrl(buildLoginRedirectUrl(`${pathname}${search}${hash}`));
}

function redirectedRecently() {
  try {
    const at = Number(window.sessionStorage.getItem(REDIRECTED_AT_KEY));
    return at > 0 && Date.now() - at < REPEAT_REDIRECT_WINDOW_MS;
  } catch {
    return false;
  }
}
