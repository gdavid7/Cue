import { env } from "@/env";
import {
  deleteWebPushSubscriptionAction,
  saveWebPushSubscriptionAction,
} from "@/utils/actions/web-push";
import type { SaveWebPushSubscriptionBody } from "@/utils/actions/web-push.validation";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

const REGISTRATION_WAIT_MS = 10_000;
// Browsers can drop or rotate a subscription without telling the page, and the
// server deletes ones the push service reports gone, so each browser re-sends
// its subscription about once a day.
const RESYNC_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SYNCED_AT_KEY = "cue:web-push:synced-at";

type ActionResult = { serverError?: string; validationErrors?: unknown };

type WebPushDeps = {
  publicKey: string | undefined;
  getRegistration: () => Promise<
    | { pushManager: Pick<PushManager, "getSubscription" | "subscribe"> }
    | undefined
  >;
  save: (
    input: SaveWebPushSubscriptionBody,
  ) => Promise<ActionResult | undefined>;
  remove: (input: { endpoint: string }) => Promise<ActionResult | undefined>;
};

/**
 * Push reaches this browser with no Cue tab open. The desktop app notifies on
 * its own, and without VAPID keys the feature is off.
 */
export function isWebPushAvailable() {
  return (
    Boolean(env.NEXT_PUBLIC_VAPID_PUBLIC_KEY) &&
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof PushManager !== "undefined" &&
    !getInboxZeroDesktopApp() &&
    !/Electron/i.test(navigator.userAgent)
  );
}

/**
 * Makes this browser's push subscription match the reader's choice. Callers
 * check permission first; "off" also runs on sign-out so the next person on
 * this browser isn't sent someone else's mail.
 */
export async function syncWebPushSubscription(
  mode: WebNotificationMode,
  deps: WebPushDeps = browserDeps(),
): Promise<boolean> {
  if (!deps.publicKey) return false;
  const registration = await deps.getRegistration();
  if (!registration) return false;
  let subscription = await registration.pushManager.getSubscription();

  if (mode === "off") {
    writeSyncedAt(null);
    if (!subscription) return true;
    const { endpoint } = subscription;
    // Unsubscribing here stops delivery even if the server call fails; the
    // push service then reports the endpoint gone and the server drops it.
    await subscription.unsubscribe();
    await deps.remove({ endpoint });
    return true;
  }

  const applicationServerKey = decodeBase64Url(deps.publicKey);
  if (
    subscription &&
    !sameBytes(subscription.options.applicationServerKey, applicationServerKey)
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey,
  });

  const { endpoint, keys } = subscription.toJSON();
  if (!endpoint || !keys?.p256dh || !keys.auth) return false;
  const result = await deps.save({
    endpoint,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    mode,
  });
  if (result?.serverError || result?.validationErrors) return false;
  writeSyncedAt(Date.now());
  return true;
}

export function isWebPushResyncDue(now = Date.now()) {
  try {
    const syncedAt = Number(window.localStorage.getItem(SYNCED_AT_KEY));
    return !syncedAt || now - syncedAt > RESYNC_INTERVAL_MS;
  } catch {
    return true;
  }
}

function browserDeps(): WebPushDeps {
  return {
    publicKey: env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
    // The worker registers after load, and never in development.
    getRegistration: () =>
      Promise.race([
        navigator.serviceWorker.ready,
        new Promise<undefined>((resolve) =>
          setTimeout(() => resolve(undefined), REGISTRATION_WAIT_MS),
        ),
      ]),
    save: saveWebPushSubscriptionAction,
    remove: deleteWebPushSubscriptionAction,
  };
}

function writeSyncedAt(value: number | null) {
  try {
    if (value === null) window.localStorage.removeItem(SYNCED_AT_KEY);
    else window.localStorage.setItem(SYNCED_AT_KEY, String(value));
  } catch {
    // Without storage the subscription is re-sent on every load.
  }
}

function decodeBase64Url(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

function sameBytes(buffer: ArrayBuffer | null, bytes: Uint8Array) {
  if (!buffer || buffer.byteLength !== bytes.length) return false;
  const view = new Uint8Array(buffer);
  return view.every((byte, index) => byte === bytes[index]);
}
