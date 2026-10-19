// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TabUnreadTitle } from "@/app/(app)/TabUnreadTitle";

const state = vi.hoisted(() => ({
  pathname: "/mail/u/0/inbox",
  unreadByAccount: {} as Record<string, number>,
  listeners: new Set<() => void>(),
  queriedAccountIds: [] as string[][],
}));

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "acc-1" }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [
        accountRow("acc-1", { includeInAllAccounts: true }),
        accountRow("acc-2", { includeInAllAccounts: true }),
        accountRow("acc-3", { includeInAllAccounts: false }),
        accountRow("acc-4", {
          includeInAllAccounts: true,
          disconnectedAt: new Date(),
        }),
      ],
    },
  }),
}));
vi.mock("@/utils/branding", () => ({ BRAND_NAME: "Cue" }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    observeMailboxCounts: (query: { accountIds: string[] }) => {
      state.queriedAccountIds.push(query.accountIds);
      return {
        getSnapshot: () => ({
          data: {
            counts: [
              {
                unreadConversations: query.accountIds.reduce(
                  (sum, id) => sum + (state.unreadByAccount[id] ?? 0),
                  0,
                ),
              },
            ],
          },
        }),
        subscribe: (listener: () => void) => {
          state.listeners.add(listener);
          return () => state.listeners.delete(listener);
        },
        close: () => {},
      };
    },
  }),
}));

function accountRow(
  id: string,
  options: { includeInAllAccounts: boolean; disconnectedAt?: Date },
) {
  return {
    id,
    email: `${id}@example.com`,
    name: id,
    image: null,
    includeInAllAccounts: options.includeInAllAccounts,
    account: {
      provider: "google",
      disconnectedAt: options.disconnectedAt ?? null,
    },
  };
}

beforeEach(() => {
  state.pathname = "/mail/u/0/inbox";
  state.unreadByAccount = { "acc-1": 3, "acc-2": 4, "acc-3": 50 };
  state.listeners.clear();
  document.title = "Cue | Mail";
});

afterEach(cleanup);

describe("TabUnreadTitle", () => {
  it("shows the current account's unread count in a single-account view", () => {
    render(<TabUnreadTitle />);

    expect(document.title).toBe("Inbox (3) – Cue");
  });

  it("sums the accounts included in All inboxes", () => {
    state.pathname = "/mail/u/0/all-inboxes";

    render(<TabUnreadTitle />);

    expect(document.title).toBe("Inbox (7) – Cue");
  });

  it("updates live as mail arrives and is read", () => {
    render(<TabUnreadTitle />);

    state.unreadByAccount["acc-1"] = 4;
    act(() => {
      for (const listener of state.listeners) listener();
    });
    expect(document.title).toBe("Inbox (4) – Cue");

    state.unreadByAccount["acc-1"] = 0;
    act(() => {
      for (const listener of state.listeners) listener();
    });
    expect(document.title).toBe("Cue | Mail");
  });

  it("puts the page title back when it unmounts", () => {
    const view = render(<TabUnreadTitle />);
    expect(document.title).toBe("Inbox (3) – Cue");

    view.unmount();

    expect(document.title).toBe("Cue | Mail");
  });
});
