import { describe, expect, it, vi } from "vitest";
import {
  handleNewMailNotificationClick,
  handleNewMailPush,
} from "@/utils/web-push/service-worker";

const ORIGIN = "https://cue.example.com";
const payload = {
  title: "Ada Lovelace",
  body: "Engine notes",
  tag: "cue-mail-account-1-message-1",
  url: "/account-1/mail?thread-id=thread-1",
  icon: "/icon.png",
};

function windowClient(
  overrides: Partial<{
    url: string;
    visibilityState: DocumentVisibilityState;
    focused: boolean;
  }> = {},
) {
  const client = {
    url: `${ORIGIN}/mail/u/0/inbox`,
    visibilityState: "hidden" as DocumentVisibilityState,
    focused: false,
    ...overrides,
    focus: vi.fn(async () => client),
    navigate: vi.fn(async () => client),
  };
  return client;
}

function clientsWith(windows: ReturnType<typeof windowClient>[]) {
  return {
    matchAll: vi.fn(async () => windows),
    openWindow: vi.fn(async () => null),
  };
}

describe("handleNewMailPush", () => {
  const CHROME_ENDPOINT = "https://fcm.googleapis.com/fcm/send/abc";
  const SAFARI_ENDPOINT = "https://web.push.apple.com/abc";

  function push({
    windows = [] as ReturnType<typeof windowClient>[],
    endpoint = CHROME_ENDPOINT as string | null,
    data = payload as unknown,
  } = {}) {
    const showNotification = vi.fn(async () => undefined);
    const done = handleNewMailPush({
      data,
      origin: ORIGIN,
      clients: clientsWith(windows),
      getSubscriptionEndpoint: async () => endpoint,
      showNotification,
    });
    return done.then(() => showNotification);
  }

  it("shows the sender and subject, tagged like the open tab's notification", async () => {
    const showNotification = await push({ windows: [windowClient()] });

    expect(showNotification).toHaveBeenCalledWith("Ada Lovelace", {
      body: "Engine notes",
      tag: "cue-mail-account-1-message-1",
      icon: "/icon.png",
      data: { url: payload.url },
    });
  });

  it("still shows while a Cue tab is visible but not focused; the shared tag collapses the tab's own", async () => {
    const showNotification = await push({
      windows: [windowClient({ visibilityState: "visible" })],
    });

    expect(showNotification).toHaveBeenCalledOnce();
  });

  it("stays quiet while the reader is in a focused Cue tab", async () => {
    const showNotification = await push({
      windows: [windowClient({ visibilityState: "visible", focused: true })],
    });

    expect(showNotification).not.toHaveBeenCalled();
  });

  it("always shows on Safari, which revokes subscriptions whose pushes show nothing", async () => {
    const focused = windowClient({ visibilityState: "visible", focused: true });

    expect(
      await push({ windows: [focused], endpoint: SAFARI_ENDPOINT }),
    ).toHaveBeenCalledOnce();
    expect(
      await push({ windows: [focused], endpoint: null }),
    ).toHaveBeenCalledOnce();
  });

  it("ignores focused windows from other sites", async () => {
    const showNotification = await push({
      windows: [
        windowClient({
          url: "https://other.example.com/",
          visibilityState: "visible",
          focused: true,
        }),
      ],
    });

    expect(showNotification).toHaveBeenCalledOnce();
  });

  it("shows a plain new-mail notification for a push it can't read", async () => {
    const showNotification = await push({ data: { title: "No tag or link" } });

    expect(showNotification).toHaveBeenCalledWith(
      "New mail",
      expect.objectContaining({ data: { url: "/" } }),
    );
  });
});

describe("handleNewMailNotificationClick", () => {
  it("focuses an open Cue window and takes it to the thread", async () => {
    const hidden = windowClient();
    const clients = clientsWith([hidden]);
    const close = vi.fn();

    await handleNewMailNotificationClick({
      notification: { data: { url: payload.url }, close },
      origin: ORIGIN,
      clients,
    });

    expect(close).toHaveBeenCalled();
    expect(hidden.focus).toHaveBeenCalled();
    expect(hidden.navigate).toHaveBeenCalledWith(`${ORIGIN}${payload.url}`);
    expect(clients.openWindow).not.toHaveBeenCalled();
  });

  it("prefers the window the reader last had in front", async () => {
    const background = windowClient();
    const front = windowClient({ focused: true, visibilityState: "visible" });

    await handleNewMailNotificationClick({
      notification: { data: { url: payload.url }, close: vi.fn() },
      origin: ORIGIN,
      clients: clientsWith([background, front]),
    });

    expect(front.navigate).toHaveBeenCalled();
    expect(background.navigate).not.toHaveBeenCalled();
  });

  it("opens a new window when no Cue window is open", async () => {
    const clients = clientsWith([]);

    await handleNewMailNotificationClick({
      notification: { data: { url: payload.url }, close: vi.fn() },
      origin: ORIGIN,
      clients,
    });

    expect(clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${payload.url}`);
  });

  it("opens a new window when the open one can't be navigated", async () => {
    const uncontrolled = windowClient();
    uncontrolled.navigate.mockRejectedValue(new TypeError("Not controlled"));
    const clients = clientsWith([uncontrolled]);

    await handleNewMailNotificationClick({
      notification: { data: { url: payload.url }, close: vi.fn() },
      origin: ORIGIN,
      clients,
    });

    expect(clients.openWindow).toHaveBeenCalledWith(`${ORIGIN}${payload.url}`);
  });

  it("never leaves Cue's origin", async () => {
    const clients = clientsWith([]);

    for (const url of ["https://evil.example.com/", "//evil.example.com/x"]) {
      await handleNewMailNotificationClick({
        notification: { data: { url }, close: vi.fn() },
        origin: ORIGIN,
        clients,
      });
    }

    expect(clients.openWindow).toHaveBeenNthCalledWith(1, `${ORIGIN}/`);
    expect(clients.openWindow).toHaveBeenNthCalledWith(2, `${ORIGIN}/`);
  });
});
