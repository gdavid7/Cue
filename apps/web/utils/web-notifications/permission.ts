import {
  announcePreferenceChange,
  hasBeenAskedToEnable,
  markAskedToEnable,
  pauseNotificationsUntil,
  readEffectiveMode,
  readQuietUntilMs,
  resumeNotifications,
  writeStoredMode,
  type WebNotificationMode,
} from "@/utils/web-notifications/preference";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import {
  isWebPushAvailable,
  syncWebPushQuietUntil,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";
import { syncWithRetry } from "@/utils/web-push/sync-with-retry";

export type WebNotificationPermission = NotificationPermission | "unsupported";

export function getWebNotificationPermission(): WebNotificationPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** The desktop app shows its own notifications. */
export function isDesktopShell() {
  return (
    Boolean(getInboxZeroDesktopApp()) || /Electron/i.test(navigator.userAgent)
  );
}

/** Only then is there anything to pause on this browser. */
export function isNotifyingInThisBrowser() {
  return (
    getWebNotificationPermission() === "granted" &&
    readEffectiveMode() !== "off" &&
    !isDesktopShell()
  );
}

/**
 * Saves the reader's choice and, only when they picked a mode that notifies,
 * asks the browser. Always called from a click, never on load.
 */
export async function chooseWebNotificationMode(
  mode: WebNotificationMode,
): Promise<WebNotificationPermission> {
  writeStoredMode(mode);
  const permission = await requestPermissionFor(mode);
  // Push carries the same choice to the server for when no tab is open.
  if (isWebPushAvailable() && (mode === "off" || permission === "granted"))
    syncWebPushSubscription(mode).catch(() => undefined);
  return permission;
}

/** Open tabs hold back their own alerts; the server holds back push. */
export function pauseWebNotifications(untilMs: number) {
  pauseNotificationsUntil(untilMs);
  syncPushPause();
}

export function resumeWebNotifications() {
  resumeNotifications();
  syncPushPause();
}

/** One quiet offer, after the first sync, to people who haven't been asked. */
export function shouldOfferWebNotifications(input: {
  permission: WebNotificationPermission;
  isDesktopApp: boolean;
  firstSyncCompleted: boolean;
  storedMode: WebNotificationMode | null;
}) {
  return (
    input.permission === "default" &&
    !input.isDesktopApp &&
    input.firstSyncCompleted &&
    input.storedMode === null &&
    !hasBeenAskedToEnable()
  );
}

export function recordWebNotificationOffer() {
  markAskedToEnable();
}

async function requestPermissionFor(
  mode: WebNotificationMode,
): Promise<WebNotificationPermission> {
  if (mode === "off") return getWebNotificationPermission();
  if (getWebNotificationPermission() !== "default")
    return getWebNotificationPermission();
  try {
    return await Notification.requestPermission();
  } catch {
    return getWebNotificationPermission();
  } finally {
    announcePreferenceChange();
  }
}

let stopPushPauseSync: (() => void) | undefined;

function syncPushPause() {
  if (!isWebPushAvailable()) return;
  // A newer pause or resume replaces one still being retried.
  stopPushPauseSync?.();
  stopPushPauseSync = syncWithRetry({
    sync: () => syncWebPushQuietUntil(readQuietUntilMs()),
    // The scoped logger reads server-only env, so the browser warns directly.
    onFailure: (attempt) =>
      console.warn(`[web-push] Pause sync failed (attempt ${attempt + 1})`),
  });
}
