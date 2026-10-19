// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebNewMailNotifications } from "@/app/(app)/WebNewMailNotifications";

const mocks = vi.hoisted(() => ({
  observeMailbox: vi.fn(),
  syncWebPush: vi.fn(),
  resyncDue: true,
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ accountIds: ["acc-1", "acc-2"] }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [
        { id: "acc-1", account: { disconnectedAt: null } },
        { id: "acc-2", account: { disconnectedAt: null } },
      ],
    },
  }),
}));
vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => true,
  isWebPushResyncDue: () => mocks.resyncDue,
  syncWebPushSubscription: mocks.syncWebPush,
}));
vi.mock("@/utils/branding", () => ({ BRAND_ICON_URL: "/icon.png" }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({ observeMailbox: mocks.observeMailbox }),
}));

beforeEach(() => {
  window.localStorage.clear();
  mocks.observeMailbox.mockReset();
  mocks.syncWebPush.mockReset();
  mocks.syncWebPush.mockResolvedValue(true);
  mocks.resyncDue = true;
  mocks.observeMailbox.mockImplementation(() => ({
    getSnapshot: () => ({ status: "loading", data: null }),
    subscribe: () => () => undefined,
    close: () => undefined,
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubPermission(permission: NotificationPermission) {
  vi.stubGlobal("Notification", { permission, requestPermission: vi.fn() });
}

function unreadInboxWatchers() {
  return mocks.observeMailbox.mock.calls.filter(
    ([query]) => query.pageSize > 1,
  );
}

describe("WebNewMailNotifications", () => {
  it("watches no mailbox when the reader turned notifications off", () => {
    stubPermission("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "off");

    render(<WebNewMailNotifications />);

    expect(mocks.observeMailbox).not.toHaveBeenCalled();
  });

  it("watches no unread mail without browser permission", () => {
    stubPermission("denied");
    render(<WebNewMailNotifications />);
    expect(mocks.observeMailbox).not.toHaveBeenCalled();
    cleanup();

    stubPermission("default");
    render(<WebNewMailNotifications />);
    // Only the one-account watcher that waits for the first sync, for the offer.
    expect(unreadInboxWatchers()).toEqual([]);
  });

  it("watches every connected account's unread inbox once permission is granted", () => {
    stubPermission("granted");

    render(<WebNewMailNotifications />);

    expect(unreadInboxWatchers()).toHaveLength(1);
    expect(unreadInboxWatchers()[0][0].accountIds).toEqual(["acc-1", "acc-2"]);
  });

  it("stays out of the way inside the Electron shell", () => {
    stubPermission("granted");
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue(
      "Mozilla/5.0 Cue/1.0 Electron/33.0.0",
    );

    render(<WebNewMailNotifications />);

    expect(mocks.observeMailbox).not.toHaveBeenCalled();
  });

  it("re-sends this browser's push subscription when a daily re-sync is due", () => {
    stubPermission("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "all");

    render(<WebNewMailNotifications />);

    expect(mocks.syncWebPush).toHaveBeenCalledExactlyOnceWith("all");
  });

  it("leaves push alone when notifications are off, blocked or recently synced", () => {
    stubPermission("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "off");
    render(<WebNewMailNotifications />);
    cleanup();

    stubPermission("denied");
    window.localStorage.setItem("cue:web-notifications:mode", "all");
    render(<WebNewMailNotifications />);
    cleanup();

    stubPermission("granted");
    mocks.resyncDue = false;
    render(<WebNewMailNotifications />);

    expect(mocks.syncWebPush).not.toHaveBeenCalled();
  });
});
