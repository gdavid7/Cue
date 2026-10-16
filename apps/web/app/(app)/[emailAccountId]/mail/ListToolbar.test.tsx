// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ListToolbar } from "./ListToolbar";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1", provider: "google" }),
}));

vi.mock("@/app/(app)/[emailAccountId]/mail/MailTitlebarNav", () => ({
  MailTitlebarNav: () => null,
}));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

afterEach(cleanup);

describe("ListToolbar labels for a selection across accounts", () => {
  it("explains why labelling is unavailable instead of hiding it", async () => {
    render(
      <ListToolbar
        {...SELECTION_PROPS}
        labelUnavailableReason="Labels belong to one account"
      />,
    );

    const label = screen.getByRole("button", { name: "Label" });
    expect(label.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(label);
    expect(
      (await screen.findAllByText("Labels belong to one account")).length,
    ).toBeGreaterThan(0);
  });
});

const SELECTION_PROPS = {
  layout: "list",
  isDesktopApp: false,
  expandedPreview: false,
  searchQuery: "",
  onSearch: vi.fn(),
  searchValue: "",
  onSearchChange: vi.fn(),
  onToggleLayout: vi.fn(),
  onTogglePreview: vi.fn(),
  onToggleAssistant: vi.fn(),
  selectedCount: 2,
  onArchiveSelected: vi.fn(),
  onDeleteSelected: vi.fn(),
  isUnreadSelected: false,
  onMarkReadSelected: vi.fn(),
  onMarkUnreadSelected: vi.fn(),
  isStarredSelected: false,
  onStarSelected: vi.fn(),
  onClearSelection: vi.fn(),
} as const;
