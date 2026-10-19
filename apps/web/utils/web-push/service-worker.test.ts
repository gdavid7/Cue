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
  it("shows the sender and subject, tagged like the open tab's notification", async () => {
    const showNotification = vi.fn(async () => undefined);

    await handleNewMailPush({
      data: payload,
      origin: ORIGIN,
      clients: clientsWith([windowClient()]),
      showNotification,
    });

    expect(showNotification).toHaveBeenCalledWith("Ada Lovelace", {
      body: "Engine notes",
      tag: "cue-mail-account-1-message-1",
      icon: "/icon.png",
      data: { url: payload.url },
    });
  });

  it("stays quiet while a Cue tab is on screen, which notifies by itself", async () => {
    const showNotification = vi.fn(async () => undefined);

    await handleNewMailPush({
      data: payload,
      origin: ORIGIN,
      clients: clientsWith([windowClient({ visibilityState: "visible" })]),
      showNotification,
    });

    expect(showNotification).not.toHaveBeenCalled();
  });

  it("ignores visible windows from other sites", async () => {
    const showNotification = vi.fn(async () => undefined);

    await handleNewMailPush({
      data: payload,
      origin: ORIGIN,
      clients: clientsWith([
        windowClient({
          url: "https://other.example.com/",
          visibilityState: "visible",
        }),
      ]),
      showNotification,
    });

    expect(showNotification).toHaveBeenCalledOnce();
  });

  it("drops a push it can't read", async () => {
    const showNotification = vi.fn(async () => undefined);

    await handleNewMailPush({
      data: { title: "No tag or link" },
      origin: ORIGIN,
      clients: clientsWith([]),
      showNotification,
    });

    expect(showNotification).not.toHaveBeenCalled();
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
