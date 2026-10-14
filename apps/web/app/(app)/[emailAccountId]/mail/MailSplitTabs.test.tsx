// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailSplitTabs } from "@/app/(app)/[emailAccountId]/mail/MailSplitTabs";

const mocks = vi.hoisted(() => ({
  createMailSplitAction: vi.fn(),
  deleteMailSplitAction: vi.fn(),
  reorderMailSplitsAction: vi.fn(),
  mutateSettings: vi.fn(),
  toastUndo: vi.fn(),
}));

vi.mock("@/utils/actions/mail-split", () => ({
  buildMailSplitFromPromptAction: vi.fn(),
  createMailSplitAction: mocks.createMailSplitAction,
  deleteMailSplitAction: mocks.deleteMailSplitAction,
  reorderMailSplitsAction: mocks.reorderMailSplitsAction,
  updateMailSplitAction: vi.fn(),
}));
vi.mock("@/utils/actions/rule", () => ({ toggleRuleAction: vi.fn() }));
vi.mock("@/components/Toast", () => ({ toastUndo: mocks.toastUndo }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "google" }),
}));
vi.mock("@/hooks/useLabels", () => ({
  useLabels: () => ({ userLabels: [], mutate: vi.fn() }),
}));
vi.mock("@/hooks/useMailSettings", () => ({
  useMailSettings: () => ({
    data: {
      splits: [
        { id: "work", name: "Work", order: 1, matchAll: true, filters: WORK },
        { id: "news", name: "News", order: 2, matchAll: false, filters: NEWS },
      ],
    },
    mutate: mocks.mutateSettings,
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-split-counts", () => ({
  useSplitCounts: () => new Map(),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/NewSplitDialog", () => ({
  NewSplitDialog: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/InboxStylePicker", () => ({
  InboxStyleDialog: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/MailSidebar", () => ({
  getMailCategories: () => [],
}));

const WORK = [{ kind: "FROM", value: "@acme.com" }];
const NEWS = [{ kind: "LABEL", value: "Label_1" }];

describe("MailSplitTabs removing a tab", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("offers an undo that brings the tab back in its place", async () => {
    mocks.deleteMailSplitAction.mockResolvedValue({});
    mocks.createMailSplitAction.mockResolvedValue({
      data: { split: { id: "work-restored" } },
    });
    mocks.reorderMailSplitsAction.mockResolvedValue({});
    const onSelectSplit = vi.fn();

    render(
      <MailSplitTabs
        splits={[
          {
            id: "work",
            name: "Work",
            deletable: true,
            matchAll: true,
            filters: [],
          },
          {
            id: "news",
            name: "News",
            deletable: true,
            matchAll: true,
            filters: [],
          },
        ]}
        activeSplitId="work"
        onSelectSplit={onSelectSplit}
        isAllAccounts={false}
        getSenders={() => []}
        countAccountIds={["account-1"]}
      />,
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "Work" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete tab" }),
    );

    await vi.waitFor(() => expect(mocks.toastUndo).toHaveBeenCalledOnce());
    expect(mocks.deleteMailSplitAction).toHaveBeenCalledWith("account-1", {
      id: "work",
    });

    await mocks.toastUndo.mock.calls[0][0].onUndo();

    expect(mocks.createMailSplitAction).toHaveBeenCalledWith("account-1", {
      name: "Work",
      matchAll: true,
      filters: WORK,
    });
    expect(mocks.reorderMailSplitsAction).toHaveBeenCalledWith("account-1", {
      ids: ["work-restored", "news"],
    });
    expect(onSelectSplit).toHaveBeenLastCalledWith("work-restored");
  });
});
