// @vitest-environment jsdom
import type { ReactNode } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NotificationsSection } from "@/app/(app)/settings/NotificationsSection";
import {
  readQuietUntilMs,
  readStoredMode,
} from "@/utils/web-notifications/preference";

const { push } = vi.hoisted(() => ({ push: { available: false } }));

vi.mock("@/components/Toast", () => ({ toastError: vi.fn() }));
vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => push.available,
  syncWebPushSubscription: vi.fn(async () => true),
  syncWebPushQuietUntil: vi.fn(async () => true),
}));
// Radix's select needs a real pointer; a native one exercises the same handler.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <select
      aria-label="Desktop notifications"
      value={value}
      disabled={disabled}
      onChange={(event) => onValueChange(event.target.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

function stubNotification(permission: NotificationPermission) {
  const api = {
    permission,
    requestPermission: vi.fn(async () => {
      api.permission = "granted";
      return "granted" as const;
    }),
  };
  vi.stubGlobal("Notification", api);
  return api;
}

beforeEach(() => {
  window.localStorage.clear();
  push.available = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("NotificationsSection", () => {
  it("is hidden when the browser has no Notification API", () => {
    render(<NotificationsSection />);

    expect(screen.queryByText("Desktop notifications")).toBeNull();
  });

  it("does not ask the browser until the reader opts in", async () => {
    const notification = stubNotification("default");
    render(<NotificationsSection />);

    expect(notification.requestPermission).not.toHaveBeenCalled();

    fireEvent.change(
      screen.getByRole("combobox", { name: "Desktop notifications" }),
      { target: { value: "important" } },
    );

    await waitFor(() =>
      expect(notification.requestPermission).toHaveBeenCalledOnce(),
    );
    expect(readStoredMode()).toBe("important");
  });

  it("says notifications arrive with no tab open when push is available", () => {
    push.available = true;
    stubNotification("granted");
    render(<NotificationsSection />);

    expect(screen.getByText(/even when Cue isn't open/i)).toBeTruthy();
  });

  it("explains how to unblock when the browser denied permission", () => {
    stubNotification("denied");
    render(<NotificationsSection />);

    expect(screen.getByText(/blocked/i)).toBeTruthy();
    expect(
      screen
        .getByRole("combobox", { name: "Desktop notifications" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("pauses this browser's notifications without turning them off, then resumes", async () => {
    stubNotification("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "important");
    render(<NotificationsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Pause…" }));
    fireEvent.click(await screen.findByRole("button", { name: /For 1 hour/ }));

    expect(readQuietUntilMs()).not.toBeNull();
    expect(readStoredMode()).toBe("important");
    expect(screen.getByText(/^Paused until /)).toBeTruthy();
    expect(screen.getByRole("img", { name: "Paused" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Resume" }));

    expect(readQuietUntilMs()).toBeNull();
    expect(screen.queryByRole("img", { name: "Paused" })).toBeNull();
    expect(screen.getByRole("button", { name: "Pause…" })).toBeTruthy();
  });

  it("says alerts resume with Cue closed when push can deliver them", async () => {
    push.available = true;
    stubNotification("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "important");
    render(<NotificationsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Pause…" }));
    fireEvent.click(await screen.findByRole("button", { name: /For 1 hour/ }));

    expect(
      screen.getByText(
        "Alerts resume on their own then, even with Cue closed.",
      ),
    ).toBeTruthy();
  });

  it("offers no pause while notifications are off", () => {
    stubNotification("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "off");
    render(<NotificationsSection />);

    expect(screen.queryByRole("button", { name: "Pause…" })).toBeNull();
  });

  it("will not pause past 30 days from a chosen date", async () => {
    stubNotification("granted");
    window.localStorage.setItem("cue:web-notifications:mode", "important");
    render(<NotificationsSection />);

    fireEvent.click(screen.getByRole("button", { name: "Pause…" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Choose date and time/ }),
    );
    const input = screen.getByLabelText("Pause until date and time");
    const pause = screen.getByRole("button", { name: "Pause" });

    fireEvent.change(input, { target: { value: localInput(40) } });
    expect(pause.hasAttribute("disabled")).toBe(true);

    fireEvent.change(input, { target: { value: localInput(2) } });
    expect(pause.hasAttribute("disabled")).toBe(false);
  });
});

function localInput(daysAhead: number) {
  const date = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
