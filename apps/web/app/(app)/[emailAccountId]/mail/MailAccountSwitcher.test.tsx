/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import { MailAccountSwitcher } from "./MailAccountSwitcher";

(globalThis as { React?: typeof React }).React = React;

const {
  mockOpenWindow,
  mockUseAccounts,
  mockUseAccount,
  mockLogOut,
  mockOpenSettings,
} = vi.hoisted(() => ({
  mockOpenWindow: vi.fn().mockResolvedValue(undefined),
  mockUseAccounts: vi.fn(),
  mockUseAccount: vi.fn(),
  mockLogOut: vi.fn(),
  mockOpenSettings: vi.fn(),
}));

vi.mock("@/utils/user", () => ({ logOut: mockLogOut }));

vi.mock("@/hooks/useSettingsDialog", () => ({
  useSettingsDialog: () => ({ openSettings: mockOpenSettings }),
}));

vi.mock("./use-mail-app-links", () => ({
  useMailAppLinks: () => ({
    appLinks: [
      { name: "Chat", href: "/account-1/assistant", icon: null },
      { name: "Rules", href: "/account-1/automation", icon: null },
    ],
    toolLinks: [],
  }),
}));

vi.mock("next/link", () => ({
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => mockUseAccounts(),
}));

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => mockUseAccount(),
}));

vi.mock("@/utils/desktop-app", () => ({
  getInboxZeroDesktopApp: () => ({ openWindow: mockOpenWindow }),
}));

vi.mock("./AllAccountsSelectionDialog", () => ({
  AllAccountsSelectionDialog: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/components/ui/dropdown-menu")>();
  return {
    ...actual,
    DropdownMenu: (props: React.ComponentProps<typeof actual.DropdownMenu>) => (
      <actual.DropdownMenu {...props} modal={false} open />
    ),
  };
});

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

if (!HTMLElement.prototype.hasPointerCapture) {
  HTMLElement.prototype.hasPointerCapture = () => false;
}
if (!HTMLElement.prototype.setPointerCapture) {
  HTMLElement.prototype.setPointerCapture = () => {};
}
if (!HTMLElement.prototype.releasePointerCapture) {
  HTMLElement.prototype.releasePointerCapture = () => {};
}
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = () => {};
}

afterEach(() => {
  cleanup();
});

describe("MailAccountSwitcher", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAccount.mockReturnValue({
      accountIds: ["account-1", "account-2"],
      emailAccount: {
        id: "account-1",
        name: "Work",
        email: "work@example.com",
        image: null,
      },
    });
    mockUseAccounts.mockReturnValue({
      data: {
        emailAccounts: [
          {
            id: "account-1",
            email: "work@example.com",
            name: "Work",
            image: null,
            accountId: "auth-1",
            includeInAllAccounts: true,
            account: { disconnectedAt: null, provider: "google" },
            user: {
              name: "Work",
              image: null,
              email: "work@example.com",
            },
            isPrimary: true,
            providerRateLimit: null,
          },
          {
            id: "account-2",
            email: "personal@example.com",
            name: "Personal",
            image: null,
            accountId: "auth-2",
            includeInAllAccounts: true,
            account: { disconnectedAt: null, provider: "google" },
            user: {
              name: "Personal",
              image: null,
              email: "personal@example.com",
            },
            isPrimary: false,
            providerRateLimit: null,
          },
        ],
      },
      mutate: vi.fn(),
    });
  });

  it.each([
    { metaKey: true },
    { ctrlKey: true },
  ])("opens a desktop window when an account is selected with %o", async (modifiers) => {
    const onSelectAccount = vi.fn();
    renderSwitcher({ onSelectAccount });

    const item = await screen.findByRole("menuitem", { name: /personal/i });
    selectMenuItem(item, modifiers);

    expect(mockOpenWindow).toHaveBeenCalledWith("/mail/u/1/inbox");
    expect(onSelectAccount).not.toHaveBeenCalled();
  });

  it("switches accounts when a DropdownMenuItem is selected without modifiers", async () => {
    const onSelectAccount = vi.fn();
    renderSwitcher({ onSelectAccount });

    const item = await screen.findByRole("menuitem", { name: /personal/i });
    selectMenuItem(item);

    expect(onSelectAccount).toHaveBeenCalledWith("account-2");
    expect(mockOpenWindow).not.toHaveBeenCalled();
  });

  it("offers both providers straight from Add another account", async () => {
    renderSwitcher({ onSelectAccount: vi.fn() });

    selectMenuItem(
      await screen.findByRole("menuitem", { name: "Add another account" }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: "Add another account",
    });
    expect(dialog.textContent).toContain("Add Google");
    expect(dialog.textContent).toContain("Add Microsoft");
  });

  it("leads out of the mail screen: the app's places, Settings and Sign out", async () => {
    renderSwitcher({ onSelectAccount: vi.fn() });

    expect(
      (await screen.findByRole("link", { name: "Rules" })).getAttribute("href"),
    ).toBe("/account-1/automation");
    selectMenuItem(screen.getByRole("menuitem", { name: "Settings" }));
    expect(mockOpenSettings).toHaveBeenCalled();

    selectMenuItem(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(mockLogOut).toHaveBeenCalledTimes(1);
  });

  it.each([
    "bar",
    "sidebar",
  ] as const)("names its %s trigger for what the menu holds, not just the account", (variant) => {
    renderSwitcher({ onSelectAccount: vi.fn(), variant });

    expect(
      screen.getByRole("button", {
        name: "Account and settings, Work, work@example.com",
      }),
    ).toBeDefined();
    expect(screen.getByText(/Signed in as/).textContent).toContain(
      "work@example.com",
    );
  });

  it("captions the phone's account tab", () => {
    renderSwitcher({ onSelectAccount: vi.fn(), variant: "bar" });

    expect(
      screen.getByRole("button", {
        name: "Account and settings, Work, work@example.com",
      }).textContent,
    ).toContain("Account");
  });
});

function renderSwitcher({
  onSelectAccount,
  variant = "compact",
}: {
  onSelectAccount: (accountId: string) => void;
  variant?: "compact" | "sidebar" | "bar";
}) {
  return render(
    <MailboxProvidersProvider enabledProviders={["google", "microsoft"]}>
      <MailAccountSwitcher
        isAllAccounts={false}
        isDesktopApp
        onSelectAccount={onSelectAccount}
        onSelectAll={vi.fn()}
        variant={variant}
      />
    </MailboxProvidersProvider>,
  );
}

function selectMenuItem(
  item: HTMLElement,
  modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {},
) {
  fireEvent.pointerDown(item, {
    button: 0,
    pointerType: "mouse",
    ...modifiers,
  });
  fireEvent.pointerUp(item, {
    button: 0,
    pointerType: "mouse",
    ...modifiers,
  });
  fireEvent.click(item);
}
