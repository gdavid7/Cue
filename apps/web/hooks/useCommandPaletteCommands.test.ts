// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { InboxIcon, MessageSquareIcon, MailsIcon } from "lucide-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCommandPaletteCommands } from "./useCommandPaletteCommands";

const router = vi.hoisted(() => ({ push: vi.fn() }));
const account = vi.hoisted(() => ({ provider: "google" }));
const rules = vi.hoisted(() => ({ enabledArg: undefined as unknown }));
const logOut = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const weather = vi.hoisted(() => ({
  dismissed: false,
  save: vi.fn(async () => true),
}));

vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/hooks/useSettingsDialog", () => ({
  useSettingsDialog: () => ({ openSettings: vi.fn() }),
}));
vi.mock("@/hooks/useRules", () => ({
  useRules: (_query: unknown, enabled: unknown) => {
    rules.enabledArg = enabled;
    return {
      data: enabled ? [{ id: "rule-1", name: "Newsletters" }] : undefined,
      isLoading: false,
    };
  },
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "account-1",
    provider: account.provider,
  }),
}));
vi.mock("@/utils/user", () => ({ logOut }));
vi.mock("@/components/Toast", () => ({ toastError }));
vi.mock("@/hooks/useTodayWeather", () => ({
  useTodayWeather: () => ({ dismissed: weather.dismissed, save: weather.save }),
}));
vi.mock("@/components/SideNav", () => ({
  useNavigation: () => ({
    manageItems: [
      { name: "Inbox", href: "/account-1/mail", icon: InboxIcon },
      { name: "Chat", href: "/account-1/assistant", icon: MessageSquareIcon },
    ],
    toolsItems: [
      {
        name: "Unsubscribe",
        href: "/account-1/bulk-unsubscribe",
        icon: MailsIcon,
      },
    ],
  }),
}));

describe("useCommandPaletteCommands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    account.provider = "google";
    weather.dismissed = false;
    weather.save.mockResolvedValue(true);
  });

  it("opens rules settings on a page that exists", () => {
    const { result } = renderHook(() => useCommandPaletteCommands());
    const command = result.current.commands.find(
      (c) => c.label === "Rules settings",
    );

    command?.action();

    expect(router.push).toHaveBeenCalledWith(
      "/account-1/automation?tab=settings",
    );
    expect(
      result.current.commands.some((c) => c.label === "Assistant Settings"),
    ).toBe(false);
  });

  it("keeps every app destination while mail actions lead the palette", () => {
    const { result } = renderHook(() =>
      useCommandPaletteCommands({ includeRules: false }),
    );
    const labels = result.current.commands
      .filter((c) => c.section === "navigation")
      .map((c) => c.label);

    expect(labels).toEqual(
      expect.arrayContaining([
        "Go to Inbox",
        "Go to Chat",
        "Go to Unsubscribe",
      ]),
    );
    expect(result.current.commands.some((c) => c.section === "rules")).toBe(
      false,
    );
  });

  it("offers sign out", () => {
    const { result } = renderHook(() => useCommandPaletteCommands());

    result.current.commands.find((c) => c.label === "Sign out")?.action();

    expect(logOut).toHaveBeenCalledTimes(1);
  });

  it("offers Cold Email Blocker only where the account menu does", () => {
    account.provider = "microsoft";
    const { result } = renderHook(() => useCommandPaletteCommands());

    expect(
      result.current.commands.some(
        (c) => c.label === "Go to Cold Email Blocker",
      ),
    ).toBe(false);
  });

  it("after Not now on Today's weather, offers to show it again and opens Today", async () => {
    const offered = () =>
      renderHook(() =>
        useCommandPaletteCommands(),
      ).result.current.commands.find(
        (c) => c.label === "Show weather on Today",
      );
    expect(offered()).toBeUndefined();

    weather.dismissed = true;
    await offered()?.action();

    // Clears the dismissal "Not now" stored, rather than a flag of its own.
    expect(weather.save).toHaveBeenCalledWith(null);
    expect(router.push).toHaveBeenCalledWith("/account-1/home");
  });

  it("says so when showing the weather again couldn't be saved", async () => {
    weather.dismissed = true;
    weather.save.mockResolvedValue(false);
    const { result } = renderHook(() => useCommandPaletteCommands());

    await result.current.commands
      .find((c) => c.label === "Show weather on Today")
      ?.action();

    expect(toastError).toHaveBeenCalledTimes(1);
  });
});
