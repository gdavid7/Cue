// Relative so the separately bundled service worker resolves it.
import { parseNewMailPushPayload } from "./new-mail-payload";

const FALLBACK_PAYLOAD = {
  title: "New mail",
  body: "",
  tag: "cue-mail",
  url: "/",
  icon: undefined,
};

// Pure handlers for app/sw.ts, written against the parts of the service worker
// API they use so they can run outside a worker.

type CueWindowClient = {
  url: string;
  visibilityState: DocumentVisibilityState;
  focused: boolean;
  focus(): Promise<unknown>;
  navigate(url: string): Promise<unknown>;
};

type WindowClients = {
  matchAll(options: {
    type: "window";
    includeUncontrolled: boolean;
  }): Promise<readonly CueWindowClient[]>;
  openWindow(url: string): Promise<unknown>;
};

export async function handleNewMailPush({
  data,
  origin,
  clients,
  getSubscriptionEndpoint,
  showNotification,
}: {
  data: unknown;
  origin: string;
  clients: Pick<WindowClients, "matchAll">;
  getSubscriptionEndpoint: () => Promise<string | null>;
  showNotification: (
    title: string,
    options: NotificationOptions,
  ) => Promise<void>;
}) {
  // Safari revokes a subscription after a few pushes that show nothing, so
  // even an unreadable push shows something.
  const payload = parseNewMailPushPayload(data) ?? FALLBACK_PAYLOAD;

  // Only a focused Cue tab makes a notification pointless; anywhere else the
  // tab's own notification shares this tag and the browser keeps one. Safari
  // (the only browser on Apple's push service) always gets one.
  const [windows, endpoint] = await Promise.all([
    findCueWindows(clients, origin),
    getSubscriptionEndpoint().catch(() => null),
  ]);
  if (
    windows.some((client) => client.focused) &&
    endpoint &&
    !isApplePushEndpoint(endpoint)
  )
    return;

  await showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: payload.icon,
    data: { url: payload.url },
  });
}

export async function handleNewMailNotificationClick({
  notification,
  origin,
  clients,
}: {
  notification: { data: unknown; close(): void };
  origin: string;
  clients: WindowClients;
}) {
  notification.close();
  const url = resolveCueUrl(notification.data, origin);

  const windows = await findCueWindows(clients, origin);
  const target =
    windows.find((client) => client.focused) ??
    windows.find((client) => client.visibilityState === "visible") ??
    windows[0];
  if (target) {
    try {
      await target.focus();
      await target.navigate(url);
      return;
    } catch {
      // A window the worker doesn't control can't be navigated from here.
    }
  }
  await clients.openWindow(url);
}

async function findCueWindows(
  clients: Pick<WindowClients, "matchAll">,
  origin: string,
) {
  const windows = await clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return windows.filter((client) => isSameOrigin(client.url, origin));
}

function resolveCueUrl(data: unknown, origin: string) {
  const path =
    data && typeof data === "object" && "url" in data ? data.url : null;
  if (typeof path === "string" && path.startsWith("/")) {
    const url = new URL(path, origin);
    if (url.origin === origin) return url.href;
  }
  return new URL("/", origin).href;
}

function isSameOrigin(url: string, origin: string) {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

function isApplePushEndpoint(endpoint: string) {
  try {
    const host = new URL(endpoint).hostname;
    return host === "push.apple.com" || host.endsWith(".push.apple.com");
  } catch {
    return true;
  }
}
