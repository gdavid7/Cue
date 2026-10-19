// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DesktopMailIndicators } from "@/app/(app)/DesktopMailIndicators";

const state = vi.hoisted(() => ({
  countedAccountIds: [] as string[][],
  setUnreadCount: vi.fn(),
}));

vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [
        accountRow("acc-1", { includeInAllAccounts: true }),
        accountRow("acc-2", { includeInAllAccounts: false }),
        accountRow("acc-3", {
          includeInAllAccounts: true,
          disconnectedAt: new Date(),
        }),
      ],
    },
  }),
}));
vi.mock("@/hooks/useInboxUnreadCount", () => ({
  useInboxUnreadCount: (accountIds: string[]) => {
    state.countedAccountIds.push(accountIds);
    return 3;
  },
}));
vi.mock("@/utils/desktop-app", () => ({
  getInboxZeroDesktopApp: () => ({ setUnreadCount: state.setUnreadCount }),
}));

afterEach(() => {
  cleanup();
  state.countedAccountIds = [];
  state.setUnreadCount.mockClear();
});

it("badges only the accounts included in All inboxes", () => {
  render(<DesktopMailIndicators />);

  expect(state.countedAccountIds.at(-1)).toEqual(["acc-1"]);
  expect(state.setUnreadCount).toHaveBeenCalledWith(3);
});

function accountRow(
  id: string,
  {
    includeInAllAccounts,
    disconnectedAt = null,
  }: { includeInAllAccounts: boolean; disconnectedAt?: Date | null },
) {
  return {
    id,
    email: `${id}@example.com`,
    name: null,
    image: null,
    includeInAllAccounts,
    account: { provider: "google", disconnectedAt },
  };
}
