/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseWebNotificationMode,
  recordWebNotificationOffer,
  shouldOfferWebNotifications,
} from "@/utils/web-notifications/permission";
import { readStoredMode } from "@/utils/web-notifications/preference";

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
