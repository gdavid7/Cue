export type WebNotificationMode = "off" | "important" | "all";

export const WEB_NOTIFICATION_MODES: WebNotificationMode[] = [
  "off",
  "important",
  "all",
];

export const DEFAULT_WEB_NOTIFICATION_MODE: WebNotificationMode = "important";

const MODE_KEY = "cue:web-notifications:mode";
const PROMPTED_KEY = "cue:web-notifications:prompted";
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

export function subscribeToPreference(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}
