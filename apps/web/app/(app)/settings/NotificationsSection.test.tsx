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
import { readStoredMode } from "@/utils/web-notifications/preference";

vi.mock("@/components/Toast", () => ({ toastError: vi.fn() }));
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
});
