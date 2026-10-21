/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isWebPushResyncDue,
  syncWebPushQuietUntil,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

vi.mock("@/utils/actions/web-push", () => ({
  saveWebPushSubscriptionAction: vi.fn(),
  deleteWebPushSubscriptionAction: vi.fn(),
  setWebPushQuietUntilAction: vi.fn(),
}));

// "BAEC" decodes to the bytes 4, 1, 2.
const PUBLIC_KEY = "BAEC";

function pushSubscription({
  endpoint = "https://fcm.googleapis.com/fcm/send/abc",
  key = [4, 1, 2],
} = {}) {
  return {
    endpoint,
    options: { applicationServerKey: new Uint8Array(key).buffer },
    toJSON: () => ({ endpoint, keys: { p256dh: "p256dh-key", auth: "auth" } }),
    unsubscribe: vi.fn(async () => true),
  };
}

function setup(existing: ReturnType<typeof pushSubscription> | null) {
  const created = pushSubscription({
    endpoint: "https://fcm.googleapis.com/fcm/send/new",
  });
  const pushManager = {
    getSubscription: vi.fn(async () => existing),
    subscribe: vi.fn(async () => created),
  };
  const deps = {
    publicKey: PUBLIC_KEY,
    getRegistration: vi.fn(async () => ({ pushManager })),
    save: vi.fn(async () => ({ data: undefined })),
    remove: vi.fn(async () => ({ data: undefined })),
    setQuietUntil: vi.fn(async () => ({ data: undefined })),
  };
  return { deps, pushManager, created };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("syncWebPushSubscription", () => {
  it("subscribes this browser and tells the server the chosen mode", async () => {
    const { deps, pushManager } = setup(null);

    await expect(sync("important", deps)).resolves.toBe(true);

    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([4, 1, 2]),
    });
    expect(deps.save).toHaveBeenCalledWith({
      endpoint: "https://fcm.googleapis.com/fcm/send/new",
      keys: { p256dh: "p256dh-key", auth: "auth" },
      mode: "important",
      quietUntil: null,
    });
    expect(isWebPushResyncDue()).toBe(false);
  });

  it("reuses the browser's existing subscription when the mode changes", async () => {
    const existing = pushSubscription();
    const { deps, pushManager } = setup(existing);

    await sync("all", deps);

    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: existing.endpoint, mode: "all" }),
    );
  });

  it("replaces a subscription made with an old server key", async () => {
    const stale = pushSubscription({ key: [9, 9, 9] });
    const { deps, pushManager } = setup(stale);

    await sync("all", deps);

    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalled();
  });

  it("unsubscribes this browser and forgets it on the server when turned off", async () => {
    const existing = pushSubscription();
    const { deps } = setup(existing);

    await sync("off", deps);

    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(deps.remove).toHaveBeenCalledWith({ endpoint: existing.endpoint });
    expect(deps.save).not.toHaveBeenCalled();
    expect(isWebPushResyncDue()).toBe(true);
  });

  it("does nothing without a public key or a service worker", async () => {
    const { deps, pushManager } = setup(null);

    await expect(sync("all", { ...deps, publicKey: undefined })).resolves.toBe(
      false,
    );
    await expect(
      sync("all", {
        ...deps,
        getRegistration: async () => undefined,
      }),
    ).resolves.toBe(false);

    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(deps.save).not.toHaveBeenCalled();
  });

  it("tries again on the next load when the server refused the subscription", async () => {
    const { deps } = setup(null);
    deps.save.mockResolvedValue({ serverError: "Unavailable" } as never);

    await expect(sync("all", deps)).resolves.toBe(false);

    expect(isWebPushResyncDue()).toBe(true);
  });
});

describe("syncWebPushQuietUntil", () => {
  it("tells the server until when this browser's subscription is paused", async () => {
    const existing = pushSubscription();
    const { deps, pushManager } = setup(existing);
    const quietUntil = Date.now() + 60_000;

    await expect(syncQuiet(quietUntil, deps)).resolves.toBe(true);
    await expect(syncQuiet(null, deps)).resolves.toBe(true);

    expect(deps.setQuietUntil.mock.calls).toEqual([
      [{ endpoint: existing.endpoint, quietUntil }],
      [{ endpoint: existing.endpoint, quietUntil: null }],
    ]);
    expect(existing.unsubscribe).not.toHaveBeenCalled();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it("has nothing to pause when this browser has no subscription", async () => {
    const { deps } = setup(null);

    await expect(syncQuiet(Date.now() + 60_000, deps)).resolves.toBe(true);

    expect(deps.setQuietUntil).not.toHaveBeenCalled();
  });

  it("saves this browser's pause with the subscription", async () => {
    const quietUntil = Date.now() + 60_000;
    window.localStorage.setItem(
      "cue:web-notifications:quiet-until",
      String(quietUntil),
    );
    const { deps } = setup(null);

    await expect(sync("all", deps)).resolves.toBe(true);

    expect(deps.save).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "https://fcm.googleapis.com/fcm/send/new",
        quietUntil,
      }),
    );
    expect(deps.setQuietUntil).not.toHaveBeenCalled();
  });
});

// The fakes cover only the parts of PushManager and the actions the sync uses.
function sync(mode: WebNotificationMode, deps: unknown) {
  return syncWebPushSubscription(
    mode,
    deps as Parameters<typeof syncWebPushSubscription>[1],
  );
}

function syncQuiet(quietUntilMs: number | null, deps: unknown) {
  return syncWebPushQuietUntil(
    quietUntilMs,
    deps as Parameters<typeof syncWebPushQuietUntil>[1],
  );
}
