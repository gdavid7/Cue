// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailFrame } from "./MailFrame";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  search: "",
  sidebar: {} as {
    isAllAccounts?: boolean;
    onSelectAllAccounts?: () => void;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => "/account-a/home",
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@inboxzero/mail-ui/MailProductFrame", () => ({
  MailProductFrame: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailMobileNav", () => ({
  MailMobileNav: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher", () => ({
  MailAccountSwitcher: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailShellSidebar", () => ({
  MailShellSidebar: (props: typeof mocks.sidebar) => {
    mocks.sidebar = props;
    return null;
  },
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: ["account-a", "account-b"].map((id) => ({
        id,
        email: `${id}@example.com`,
        name: null,
        image: null,
        includeInAllAccounts: true,
        account: { disconnectedAt: null, provider: "google" },
      })),
    },
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "account-a",
    accountIds: ["account-a", "account-b"],
  }),
}));

describe("MailFrame on Today", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.search = "";
  });
  afterEach(cleanup);

  it("All accounts stays on Today, across accounts", () => {
    render(<MailFrame activeType="today">Today</MailFrame>);

    expect(mocks.sidebar.isAllAccounts).toBe(false);
    mocks.sidebar.onSelectAllAccounts?.();
    expect(mocks.push).toHaveBeenCalledWith("/account-a/home?accounts=all");
  });

  it("shows the All inboxes sidebar on Today across accounts", () => {
    mocks.search = "accounts=all";
    render(<MailFrame activeType="today">Today</MailFrame>);

    expect(mocks.sidebar.isAllAccounts).toBe(true);
  });
});
