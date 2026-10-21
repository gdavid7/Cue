export type WebNotificationMode = "off" | "important" | "all";

export const WEB_NOTIFICATION_MODES: WebNotificationMode[] = [
  "off",
  "important",
  "all",
];

export const DEFAULT_WEB_NOTIFICATION_MODE: WebNotificationMode = "important";

const MODE_KEY = "cue:web-notifications:mode";
const PROMPTED_KEY = "cue:web-notifications:prompted";
const HINT_SHOWN_KEY = "cue:web-notifications:off-hint-shown";
const QUIET_UNTIL_KEY = "cue:web-notifications:quiet-until";
/** A pause longer than this is more likely a typo than a plan. */
export const MAX_QUIET_MS = 30 * 24 * 60 * 60 * 1000;
// setTimeout overflows past about 24.8 days; a longer pause re-arms.
const MAX_TIMER_MS = 2 ** 31 - 1;
const CHANGE_EVENT = "cue:web-notifications:change";

// Permission is per browser, so the choice lives next to it rather than in the
// account: a second browser asks for its own permission anyway.
export function readStoredMode(): WebNotificationMode | null {
  try {
    const value = window.localStorage.getItem(MODE_KEY);
    return WEB_NOTIFICATION_MODES.find((mode) => mode === value) ?? null;
  } catch {
    return null;
  }
}

export function writeStoredMode(mode: WebNotificationMode) {
  try {
    window.localStorage.setItem(MODE_KEY, mode);
  } catch {
    // Without storage the choice lasts until reload.
  }
  announcePreferenceChange();
}

/** Also called when the browser's permission answer arrives, which isn't an event. */
export function announcePreferenceChange() {
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function readEffectiveMode(): WebNotificationMode {
  return readStoredMode() ?? DEFAULT_WEB_NOTIFICATION_MODE;
}

export function hasBeenAskedToEnable() {
  try {
    return window.localStorage.getItem(PROMPTED_KEY) === "1";
  } catch {
    // Unknown: asking again would nag, so act as if already asked.
    return true;
  }
}

export function markAskedToEnable() {
  try {
    window.localStorage.setItem(PROMPTED_KEY, "1");
  } catch {
    // The prompt is also gated on the session by the caller.
  }
}

export function readOffHintShownAtMs(): number | null {
  try {
    const value = Number(window.localStorage.getItem(HINT_SHOWN_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

export function writeOffHintShownAtMs(ms: number) {
  try {
    window.localStorage.setItem(HINT_SHOWN_KEY, String(ms));
  } catch {
    // Without storage the hint can only show once per page load.
  }
}

/**
 * A pause is separate from the mode, so pausing never reads as notifications
 * being off. It lives with the mode because it is per browser too, and an
 * expired pause reads as none, so nothing has to clear it on time.
 */
export function readQuietUntilMs(now = Date.now()): number | null {
  try {
    const value = Number(window.localStorage.getItem(QUIET_UNTIL_KEY));
    return Number.isFinite(value) && value > now ? value : null;
  } catch {
    return null;
  }
}

/** A time already past is ignored; one beyond the limit is cut to it. */
export function pauseNotificationsUntil(untilMs: number, now = Date.now()) {
  if (!(untilMs > now)) return;
  try {
    window.localStorage.setItem(
      QUIET_UNTIL_KEY,
      String(Math.min(untilMs, now + MAX_QUIET_MS)),
    );
  } catch {
    // Without storage there is nowhere to keep a pause; notifications go on.
  }
  announcePreferenceChange();
}

export function resumeNotifications() {
  try {
    window.localStorage.removeItem(QUIET_UNTIL_KEY);
  } catch {
    // Nothing stored means nothing to resume.
  }
  announcePreferenceChange();
}

/**
 * Other tabs' changes arrive as storage events, and a pause's end arrives as a
 * timer, so every reader sees notifications resume without a reload.
 */
export function subscribeToPreference(onChange: () => void) {
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  const armQuietTimer = () => {
    clearTimeout(quietTimer);
    quietTimer = undefined;
    const untilMs = readQuietUntilMs();
    if (untilMs === null) return;
    quietTimer = setTimeout(
      () => {
        armQuietTimer();
        onChange();
      },
      Math.min(untilMs - Date.now(), MAX_TIMER_MS),
    );
  };
  const handleChange = () => {
    armQuietTimer();
    onChange();
  };
  armQuietTimer();
  window.addEventListener(CHANGE_EVENT, handleChange);
  window.addEventListener("storage", handleChange);
  return () => {
    clearTimeout(quietTimer);
    window.removeEventListener(CHANGE_EVENT, handleChange);
    window.removeEventListener("storage", handleChange);
  };
}
