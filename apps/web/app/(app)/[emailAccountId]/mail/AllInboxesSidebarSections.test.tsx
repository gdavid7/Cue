/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import type { EmailLabel } from "@/providers/email-label-types";
import type { OutlookFolder } from "@/utils/outlook/folders";
import { AllInboxesSidebarSections } from "./AllInboxesSidebarSections";

(globalThis as { React?: typeof React }).React = React;

const labelsByAccount: Record<string, EmailLabel[]> = {};
const foldersByAccount: Record<string, OutlookFolder[]> = {};
const mockUseLabels = vi.fn((accountId: string) => ({
  userLabels: labelsByAccount[accountId] ?? [],
  isLoading: false,
  error: undefined,
  mutate: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/components/ui/sidebar", () => ({
  SidebarTrigger: () => null,
}));

// Its log-out button pulls in server-only modules.
vi.mock("@/components/ErrorDisplay", () => ({ ErrorDisplay: () => null }));

vi.mock("@/hooks/useLabels", () => ({
  useLabels: (accountId: string) => mockUseLabels(accountId),
}));

vi.mock("@/hooks/useFolders", () => ({
  useFolders: (_provider: string, accountId: string) => ({
    folders: foldersByAccount[accountId] ?? [],
    isLoading: false,
    error: undefined,
    mutate: vi.fn(),
  }),
}));

// Accounts are addressed by position: personal is /mail/u/0, work /mail/u/1.
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "personal",
    accountIds: ["personal", "work"],
  }),
}));

vi.mock("@/hooks/useLabelCounts", () => ({
  useLabelCounts: () => ({ countsById: new Map(), mutate: vi.fn() }),
}));

beforeEach(() => {
  window.localStorage.clear();
  mockUseLabels.mockClear();
  for (const key of Object.keys(labelsByAccount)) delete labelsByAccount[key];
  for (const key of Object.keys(foldersByAccount)) delete foldersByAccount[key];
});

afterEach(cleanup);

describe("AllInboxesSidebarSections", () => {
  it("opens each account's own label or folder in that account's view", () => {
    labelsByAccount.personal = [
      { id: "Label_7", name: "Receipts", type: "user" },
    ];
    labelsByAccount.work = [{ id: "cat-1", name: "Clients", type: "user" }];
    foldersByAccount.work = [
      {
        id: "folder-1",
        displayName: "Projects",
        childFolders: [],
      } as unknown as OutlookFolder,
    ];

    render(
      <AllInboxesSidebarSections
        emailAccounts={[
          emailAccount({ id: "personal", provider: "google" }),
          emailAccount({ id: "work", provider: "microsoft" }),
        ]}
      />,
    );

    const personal = screen.getByRole("region", {
      name: "personal@example.com",
    });
    expect(link(personal, "Receipts")).toBe("/mail/u/0/label/receipts");

    const work = screen.getByRole("region", { name: "work@example.com" });
    expect(link(work, "Projects")).toBe("/mail/u/1/folder/projects");
    expect(link(work, "Clients")).toBe("/mail/u/1/label/clients");
    expect(work.textContent).toContain("Categories");
  });

  it("starts collapsed past two accounts and remembers each account's choice", () => {
    labelsByAccount.b = [{ id: "Label_1", name: "Travel", type: "user" }];
    const accounts = ["a", "b", "c"].map((id) => emailAccount({ id }));

    const { unmount } = render(
      <AllInboxesSidebarSections emailAccounts={accounts} />,
    );

    expect(screen.queryByText("Travel")).toBeNull();
    // Closed sections don't fetch their labels.
    expect(mockUseLabels).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /b@example\.com/ }));
    expect(screen.getByText("Travel")).toBeDefined();

    unmount();
    render(<AllInboxesSidebarSections emailAccounts={accounts} />);

    expect(screen.getByText("Travel")).toBeDefined();
    expect(
      screen
        .getByRole("button", { name: /a@example\.com/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
  });
});

function link(container: HTMLElement, name: string) {
  return Array.from(container.querySelectorAll("a"))
    .find((anchor) => anchor.textContent?.includes(name))
    ?.getAttribute("href");
}

function emailAccount({
  id,
  provider = "google",
}: {
  id: string;
  provider?: string;
}): GetEmailAccountsResponse["emailAccounts"][number] {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    image: null,
    accountId: `auth-${id}`,
    includeInAllAccounts: true,
    account: { disconnectedAt: null, provider },
    user: { name: null, image: null, email: `${id}@example.com` },
    isPrimary: false,
    providerRateLimit: null,
  } as GetEmailAccountsResponse["emailAccounts"][number];
}
