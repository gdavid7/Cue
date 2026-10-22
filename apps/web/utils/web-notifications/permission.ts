import {
  announcePreferenceChange,
  hasBeenAskedToEnable,
  markAskedToEnable,
  readEffectiveMode,
  readQuietUntilMs,
  writeStoredMode,
  type WebNotificationMode,
} from "@/utils/web-notifications/preference";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import {
  isWebPushAvailable,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";

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
  // Push carries the same choice to the server for when no tab is open. A
  // pause keeps push off; the open tabs turn it back on when the pause ends.
  if (
    isWebPushAvailable() &&
    (mode === "off" ||
      (permission === "granted" && readQuietUntilMs() === null))
  )
    syncWebPushSubscription(mode).catch(() => undefined);
  return permission;
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
