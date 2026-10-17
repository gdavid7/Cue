import { SESSION_EXPIRED_ERROR_CODE } from "@/utils/config";
import { buildLoginRedirectUrl } from "@/utils/redirect";

// Shared by API responses, server actions, and the sign-in prompt, so every
// signed-out surface reads the same and clients can recognize it.
export const SESSION_EXPIRED_MESSAGE = "Session expired. Please sign in again.";

type SessionExpiredPrompt = (signIn: () => void) => void;

let state: "active" | "held" | "redirected" = "active";
let armedBy = 0;
const prompts = new Set<SessionExpiredPrompt>();

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
export function armSessionExpiredRedirect() {
  armedBy += 1;
  return () => {
    armedBy -= 1;
  };
}

/**
 * Sends a signed-out browser to log in once, however many requests notice.
 * While a composer is open it asks through that composer's prompt instead, so
 * a redirect never takes the page out from under someone typing.
 */
export function notifySessionExpired() {
  if (typeof window === "undefined" || armedBy === 0 || state !== "active")
    return;
  if (prompts.size === 0) {
    redirectToLogin();
    return;
  }
  state = "held";
  for (const prompt of prompts) prompt(redirectToLogin);
}

/**
 * Keeps a session-expired redirect from firing while the caller is mounted.
 * The prompt receives the redirect to run once the user chooses to sign in.
 */
export function holdSessionExpiredRedirect(prompt: SessionExpiredPrompt) {
  prompts.add(prompt);
  return () => {
    prompts.delete(prompt);
    if (state === "held" && prompts.size === 0) redirectToLogin();
  };
}

function redirectToLogin() {
  if (state === "redirected") return;
  state = "redirected";
  const { pathname, search, hash } = window.location;
  window.location.assign(buildLoginRedirectUrl(`${pathname}${search}${hash}`));
}
