// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailFrame, useMailScreenFrame } from "./MailFrame";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  pathname: "/account-a/home",
  search: "",
  sidebar: {} as {
    activeType?: string | null;
    activeLabelId?: string | null;
    isAllAccounts?: boolean;
    onSelectAllAccounts?: () => void;
  },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  usePathname: () => mocks.pathname,
  useSearchParams: () => new URLSearchParams(mocks.search),
}));
vi.mock("@inboxzero/mail-ui/MailProductFrame", () => ({
  MailProductFrame: ({
    children,
    accountSwitcher,
  }: {
    children: ReactNode;
    accountSwitcher?: ReactNode;
  }) => (
    <div>
      {children}
      {accountSwitcher}
    </div>
  ),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailMobileNav", () => ({
  MailMobileNav: () => <nav aria-label="Frame phone bar" />,
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
vi.mock("@/hooks/use-mobile", () => ({
  useIsLargeScreen: () => true,
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
    mocks.pathname = "/account-a/home";
    mocks.search = "";
  });
  afterEach(cleanup);

  it("All accounts stays on Today, across accounts", () => {
    render(<MailFrame>Today</MailFrame>);

    expect(mocks.sidebar.activeType).toBe("today");
    expect(mocks.sidebar.isAllAccounts).toBe(false);
    mocks.sidebar.onSelectAllAccounts?.();
    expect(mocks.push).toHaveBeenCalledWith("/account-a/home?accounts=all");
  });

  it("shows the All inboxes sidebar on Today across accounts", () => {
    mocks.search = "accounts=all";
    render(<MailFrame>Today</MailFrame>);

    expect(mocks.sidebar.isAllAccounts).toBe(true);
  });
});

describe("MailFrame around the mail screen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pathname = "/mail/u/0/label/receipts";
    mocks.search = "";
  });
  afterEach(cleanup);

  it("highlights the mailbox and runs the actions the mail screen hands it", () => {
    const selectAll = vi.fn();
    const { rerender } = render(
      <MailFrame>
        <MailScreenStub selectAll={selectAll} ownsPhoneBar={false} />
      </MailFrame>,
    );

    expect(mocks.sidebar.activeType).toBeNull();
    expect(mocks.sidebar.activeLabelId).toBe("Label_7");
    mocks.sidebar.onSelectAllAccounts?.();
    expect(selectAll).toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(screen.getByRole("navigation", { name: "Frame phone bar" }));

    // An open conversation's phone bar replaces the frame's own.
    rerender(
      <MailFrame>
        <MailScreenStub selectAll={selectAll} ownsPhoneBar />
      </MailFrame>,
    );
    expect(
      screen.queryByRole("navigation", { name: "Frame phone bar" }),
    ).toBeNull();

    // And the frame's comes back once the conversation closes.
    rerender(
      <MailFrame>
        <MailScreenStub selectAll={selectAll} ownsPhoneBar={false} />
      </MailFrame>,
    );
    expect(screen.getByRole("navigation", { name: "Frame phone bar" }));
  });

  it("treats an unreadable mail address as mail, not Today", () => {
    mocks.pathname = "/mail/u/not-a-number";
    render(<MailFrame>{null}</MailFrame>);

    expect(mocks.sidebar.activeType).toBe("inbox");
  });

  it("falls back to its own actions once the mail screen is gone", () => {
    const { rerender } = render(
      <MailFrame>
        <MailScreenStub selectAll={vi.fn()} ownsPhoneBar={false} />
      </MailFrame>,
    );
    rerender(<MailFrame>{null}</MailFrame>);

    expect(mocks.sidebar.activeLabelId).toBeNull();
    mocks.sidebar.onSelectAllAccounts?.();
    expect(mocks.push).toHaveBeenCalledWith("/mail/u/0/all-inboxes/inbox");
  });
});

function MailScreenStub({
  selectAll,
  ownsPhoneBar,
}: {
  selectAll: () => void;
  ownsPhoneBar: boolean;
}) {
  useMailScreenFrame({
    activeType: null,
    activeLabelId: "Label_7",
    activeFolderId: null,
    ownsPhoneBar,
    onSelectAllAccounts: selectAll,
    onMailboxItemDeleted: async () => {},
  });
  return null;
}
