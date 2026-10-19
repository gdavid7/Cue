import { beginRumAction } from "@/utils/analytics/rum-actions";
import { getPendingAuthProvider } from "@/utils/analytics/auth-funnel";
import { isLocalMailboxMarked } from "@/utils/mail-engine/local-mailbox-cookie";

const ACCOUNT_SWITCH_KEY = "cue-rum-account-switch";
const ACCOUNT_SWITCH_MAX_AGE_MS = 2 * 60 * 1000;
// The mail screen mounting later than this came from elsewhere in the app, so
// the time since the page loaded is not an app open.
const APP_OPEN_MAX_MOUNT_MS = 60_000;

let started = false;

/** Account switches reload the page, so the start travels in session storage. */
export function markRumAccountSwitch() {
  try {
    sessionStorage.setItem(ACCOUNT_SWITCH_KEY, String(Date.now()));
  } catch {
    // Without storage the switch is simply not timed.
  }
}

/** The epoch time a recent account switch began, once; null when none did. */
export function takeRumAccountSwitch(now: number): number | null {
  let value = 0;
  try {
    value = Number(sessionStorage.getItem(ACCOUNT_SWITCH_KEY));
    sessionStorage.removeItem(ACCOUNT_SWITCH_KEY);
  } catch {
    return null;
  }
  const age = now - value;
  return value > 0 && age >= 0 && age <= ACCOUNT_SWITCH_MAX_AGE_MS
    ? value
    : null;
}

export function classifyAppOpen({
  hasLocalStore,
  justSignedIn,
}: {
  hasLocalStore: boolean;
  justSignedIn: boolean;
}) {
  if (hasLocalStore) return "app_open_returning";
  return justSignedIn ? "app_open_fresh_sign_in" : "app_open_cold";
}

/**
 * Starts the clock for this page load's first inbox row: from the account
 * switch that caused the load, or else from navigation start, split by what
 * the browser already held. Only the first call of a page load counts.
 */
export function startRumAppOpen(accountId: string) {
  if (started) return;
  started = true;
  const switchedAt = takeRumAccountSwitch(Date.now());
  if (switchedAt !== null) {
    beginRumAction("account_switch_first_row", {
      startedAt: switchedAt - performance.timeOrigin,
    });
    return;
  }
  if (performance.now() > APP_OPEN_MAX_MOUNT_MS) return;
  beginRumAction(
    classifyAppOpen({
      hasLocalStore: isLocalMailboxMarked(accountId),
      justSignedIn: getPendingAuthProvider() !== "unknown",
    }),
    { startedAt: 0 },
  );
}

export function resetRumAppOpenForTesting() {
  started = false;
}
