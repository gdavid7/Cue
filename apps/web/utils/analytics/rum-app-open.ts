import { beginRumAction } from "@/utils/analytics/rum-actions";
import { getPendingAuthProvider } from "@/utils/analytics/auth-funnel";
import { parseMailPath } from "@/utils/mail-url";
import { isLocalMailboxMarked } from "@/utils/mail-engine/local-mailbox-cookie";

const ACCOUNT_SWITCH_KEY = "cue-rum-account-switch";
const ACCOUNT_SWITCH_MAX_AGE_MS = 2 * 60 * 1000;
// Only for a browser that cannot say which address the page was loaded at.
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

export function clearRumAccountSwitch() {
  try {
    sessionStorage.removeItem(ACCOUNT_SWITCH_KEY);
  } catch {
    // Nothing to clear without storage.
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
  // Read first so the marker never outlives the load it was written for.
  const switchedAt = takeRumAccountSwitch(Date.now());
  if (!documentLoadedOnMailRoute()) return;
  if (switchedAt !== null) {
    beginRumAction("account_switch_first_row", {
      startedAt: switchedAt - performance.timeOrigin,
    });
    return;
  }
  beginRumAction(
    classifyAppOpen({
      hasLocalStore: isLocalMailboxMarked(accountId),
      justSignedIn: getPendingAuthProvider() !== "unknown",
    }),
    { startedAt: 0 },
  );
}

// Soft navigations keep the document, so the address it was loaded at tells
// whether this mount is the first screen of a hard navigation to mail, or a
// move there from another page, which is not an app open.
function documentLoadedOnMailRoute() {
  const entry = performance.getEntriesByType("navigation")[0];
  if (!entry) return performance.now() <= APP_OPEN_MAX_MOUNT_MS;
  try {
    return parseMailPath(new URL(entry.name).pathname) !== null;
  } catch {
    return false;
  }
}

export function resetRumAppOpenForTesting() {
  started = false;
}
