// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NOTIFICATIONS_OFF_HINT_ID,
  NotificationsOffHint,
} from "@/app/(app)/[emailAccountId]/mail/NotificationsOffHint";

const state = vi.hoisted(() => ({
  dismissedHints: [] as string[],
  dismiss: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "acc-1" }),
}));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({
    data: { dismissedHints: state.dismissedHints },
    mutate: vi.fn(),
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/TodayIntroLine", () => ({
  getTodayIntroHintId: (emailAccountId: string) =>
    `today-intro:${emailAccountId}`,
}));
vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => false,
  syncWebPushSubscription: vi.fn(),
}));
vi.mock("@/utils/actions/hints", () => ({
  dismissHintAction: state.dismiss,
}));

const HINT = "Notifications are off, so new mail won't alert you.";

describe("NotificationsOffHint", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("cue:web-notifications:prompted", "1");
    state.dismissedHints = ["today-intro:acc-1"];
    state.dismiss.mockClear();
    setPermission("default");
  });
  afterEach(cleanup);

  it("offers to turn notifications on after the offer was passed on", () => {
    render(<NotificationsOffHint ready />);
    expect(screen.getByText(HINT)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Turn on" })).toBeTruthy();
  });

  it("explains how to re-enable when the browser blocks notifications", () => {
    setPermission("denied");
    render(<NotificationsOffHint ready />);
    expect(screen.getByText(/allow them for this site/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Turn on" })).toBeNull();
  });

  it("waits for the Today pointer to be dismissed", () => {
    state.dismissedHints = [];
    render(<NotificationsOffHint ready />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("stays away before the person has been asked", () => {
    window.localStorage.removeItem("cue:web-notifications:prompted");
    render(<NotificationsOffHint ready />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("stays away when notifications are on", () => {
    setPermission("granted");
    render(<NotificationsOffHint ready />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("shows at most once per interval", () => {
    const first = render(<NotificationsOffHint ready />);
    expect(screen.getByText(HINT)).toBeTruthy();
    first.unmount();
    render(<NotificationsOffHint ready />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("stays away after it was dismissed for good", () => {
    state.dismissedHints = ["today-intro:acc-1", NOTIFICATIONS_OFF_HINT_ID];
    render(<NotificationsOffHint ready />);
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it("saves the dismissal", () => {
    render(<NotificationsOffHint ready />);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(state.dismiss).toHaveBeenCalledWith({
      hintId: NOTIFICATIONS_OFF_HINT_ID,
    });
  });
});

function setPermission(permission: NotificationPermission) {
  Object.defineProperty(window, "Notification", {
    value: { permission },
    configurable: true,
    writable: true,
  });
}
