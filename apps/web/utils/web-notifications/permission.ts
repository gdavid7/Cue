import {
  announcePreferenceChange,
  hasBeenAskedToEnable,
  markAskedToEnable,
  writeStoredMode,
  type WebNotificationMode,
} from "@/utils/web-notifications/preference";
import {
  isWebPushAvailable,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";

export type WebNotificationPermission = NotificationPermission | "unsupported";

export function getWebNotificationPermission(): WebNotificationPermission {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
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
