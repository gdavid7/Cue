// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { SunIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SideNavMenu } from "./SideNavMenu";

(globalThis as { React?: typeof React }).React = React;

vi.mock("next/navigation", () => ({ usePathname: () => "/a/automation" }));
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    prefetch: _prefetch,
    ...props
  }: React.ComponentProps<"a"> & { prefetch?: boolean }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/utils/analytics/posthog-client", () => ({
  posthog: { capture: vi.fn() },
}));
vi.mock("@/utils/mail-engine/MailEngineHost", () => ({
  useMailEngineStarting: () => false,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: React.ReactNode }) => (
    <ul>{children}</ul>
  ),
  SidebarMenuItem: ({ children }: { children: React.ReactNode }) => (
    <li>{children}</li>
  ),
  SidebarMenuButton: ({
    children,
    asChild: _asChild,
    isActive: _isActive,
    sidebarName: _sidebarName,
    tooltip: _tooltip,
    ...props
  }: Record<string, unknown> & { children: React.ReactElement }) => (
    <div {...props}>{children}</div>
  ),
  useSidebar: () => ({ closeMobileSidebar: vi.fn() }),
}));

afterEach(cleanup);

describe("SideNavMenu", () => {
  it("shows a disabled item as a row, not a link", () => {
    render(
      <SideNavMenu
        activeHref="/a/automation"
        items={[{ name: "Today", href: "", icon: SunIcon, disabled: true }]}
      />,
    );

    expect(screen.getByText("Today")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Today").closest("[aria-disabled]")?.tagName).toBe(
      "SPAN",
    );
  });

  it("links an enabled item", () => {
    render(
      <SideNavMenu
        activeHref="/a/automation"
        items={[{ name: "Today", href: "/a/home", icon: SunIcon }]}
      />,
    );

    expect(screen.getByRole("link").getAttribute("href")).toBe("/a/home");
  });
});
