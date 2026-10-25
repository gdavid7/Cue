/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseWebNotificationMode,
  pauseWebNotifications,
  recordWebNotificationOffer,
  resumeWebNotifications,
  shouldOfferWebNotifications,
} from "@/utils/web-notifications/permission";
import {
  readQuietUntilMs,
  readStoredMode,
} from "@/utils/web-notifications/preference";
import {
  syncWebPushQuietUntil,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";

const { push } = vi.hoisted(() => ({ push: { available: true } }));

vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => push.available,
  syncWebPushSubscription: vi.fn(async () => true),
  syncWebPushQuietUntil: vi.fn(async () => true),
}));

function stubNotification(
  permission: NotificationPermission,
  grant: NotificationPermission = "granted",
) {
  const requestPermission = vi.fn(async () => grant);
  vi.stubGlobal("Notification", { permission, requestPermission });
  return requestPermission;
}

beforeEach(() => {
  window.localStorage.clear();
  push.available = true;
  vi.mocked(syncWebPushSubscription).mockClear();
  vi.mocked(syncWebPushQuietUntil).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("chooseWebNotificationMode", () => {
  it("asks the browser only when the reader picks a mode that notifies", async () => {
    const requestPermission = stubNotification("default");

    await chooseWebNotificationMode("off");
    expect(requestPermission).not.toHaveBeenCalled();
    expect(readStoredMode()).toBe("off");

    await chooseWebNotificationMode("important");
    expect(requestPermission).toHaveBeenCalledOnce();
    expect(readStoredMode()).toBe("important");
  });

  it("does not ask again once the browser has answered", async () => {
    const requestPermission = stubNotification("denied");

    const result = await chooseWebNotificationMode("all");

    expect(requestPermission).not.toHaveBeenCalled();
    expect(result).toBe("denied");
    expect(readStoredMode()).toBe("all");
  });

  it("subscribes this browser to push with the mode once notifications are allowed", async () => {
    stubNotification("default", "granted");

    await chooseWebNotificationMode("all");

    expect(syncWebPushSubscription).toHaveBeenCalledWith("all");
  });

  it("unsubscribes this browser from push when turned off", async () => {
    stubNotification("granted");

    await chooseWebNotificationMode("off");

    expect(syncWebPushSubscription).toHaveBeenCalledWith("off");
  });

  it("leaves push alone when notifications aren't allowed or push is unavailable", async () => {
    stubNotification("default", "denied");
    await chooseWebNotificationMode("important");

    push.available = false;
    stubNotification("granted");
    await chooseWebNotificationMode("all");

    expect(syncWebPushSubscription).not.toHaveBeenCalled();
  });
});

describe("pausing notifications", () => {
  it("keeps this browser subscribed and tells the server until when it is paused", () => {
    stubNotification("granted");
    const until = Date.now() + 60 * 60 * 1000;

    pauseWebNotifications(until);
    expect(readQuietUntilMs()).toBe(until);
    expect(syncWebPushQuietUntil).toHaveBeenLastCalledWith(until);

    pauseWebNotifications(until + 1000);
    expect(syncWebPushQuietUntil).toHaveBeenLastCalledWith(until + 1000);

    resumeWebNotifications();
    expect(readQuietUntilMs()).toBeNull();
    expect(syncWebPushQuietUntil).toHaveBeenLastCalledWith(null);
    expect(syncWebPushSubscription).not.toHaveBeenCalled();
  });

  it("retries a pause the server didn't get, until a newer change replaces it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      stubNotification("granted");
      const quiet = vi.mocked(syncWebPushQuietUntil);
      quiet.mockResolvedValue(false);
      const until = Date.now() + 60 * 60 * 1000;

      pauseWebNotifications(until);
      await vi.advanceTimersByTimeAsync(0);
      expect(quiet).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(quiet).toHaveBeenCalledTimes(2);
      expect(quiet).toHaveBeenLastCalledWith(until);

      resumeWebNotifications();
      await vi.advanceTimersByTimeAsync(0);
      expect(quiet).toHaveBeenCalledTimes(3);
      expect(quiet).toHaveBeenLastCalledWith(null);

      quiet.mockResolvedValue(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      // Only the resume's own retry runs; the pause's was cancelled.
      expect(quiet).toHaveBeenCalledTimes(4);
      expect(quiet).toHaveBeenLastCalledWith(null);

      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(quiet).toHaveBeenCalledTimes(4);
    } finally {
      vi.mocked(syncWebPushQuietUntil).mockResolvedValue(true);
      vi.useRealTimers();
    }
  });

  it("pauses only this tab's alerts when push is unavailable", () => {
    push.available = false;

    pauseWebNotifications(Date.now() + 60_000);

    expect(readQuietUntilMs()).not.toBeNull();
    expect(syncWebPushQuietUntil).not.toHaveBeenCalled();
  });

  it("still saves a mode chosen during a pause to push", async () => {
    stubNotification("granted");
    pauseWebNotifications(Date.now() + 60_000);

    await chooseWebNotificationMode("all");

    expect(syncWebPushSubscription).toHaveBeenCalledWith("all");
  });
});

describe("shouldOfferWebNotifications", () => {
  const ready = {
    permission: "default" as const,
    isDesktopApp: false,
    firstSyncCompleted: true,
    storedMode: null,
  };

  it("offers once after the first sync", () => {
    expect(shouldOfferWebNotifications(ready)).toBe(true);
    recordWebNotificationOffer();
    expect(shouldOfferWebNotifications(ready)).toBe(false);
  });

  it("does not offer before the first sync finishes", () => {
    expect(
      shouldOfferWebNotifications({ ...ready, firstSyncCompleted: false }),
    ).toBe(false);
  });

  it("does not offer when the reader already chose, the browser answered, or the desktop app handles it", () => {
    expect(shouldOfferWebNotifications({ ...ready, storedMode: "off" })).toBe(
      false,
    );
    expect(
      shouldOfferWebNotifications({ ...ready, permission: "denied" }),
    ).toBe(false);
    expect(
      shouldOfferWebNotifications({ ...ready, permission: "unsupported" }),
    ).toBe(false);
    expect(shouldOfferWebNotifications({ ...ready, isDesktopApp: true })).toBe(
      false,
    );
  });
});
