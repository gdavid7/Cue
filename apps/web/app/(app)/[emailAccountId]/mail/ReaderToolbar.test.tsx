/** @vitest-environment jsdom */

import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReaderToolbar } from "@/app/(app)/[emailAccountId]/mail/ReaderToolbar";
import { ThreadActionsMenu } from "@/app/(app)/[emailAccountId]/mail/ThreadActionsMenu";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(
  globalThis as unknown as { ResizeObserver?: typeof MockResizeObserver }
).ResizeObserver = MockResizeObserver;

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ execute: vi.fn() }),
}));
vi.mock("@/utils/actions/thread-assist", () => ({
  markNeedsReplyAction: { bind: () => vi.fn() },
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "account-1",
    provider: "google",
    userEmail: "user@example.com",
  }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-sender-commands", () => ({
  useSenderCommands: () => ({
    canManageAutoArchive: false,
    isUnsubscribeDisabled: false,
    unsubscribeLabel: "Unsubscribe from sender",
    isAutoArchived: false,
    isAutoArchiveStatusLoading: false,
    isUpdatingAutoArchive: false,
    onToggleAutoArchive: vi.fn(),
    onUnsubscribe: vi.fn(),
    PremiumModal: () => null,
  }),
}));

afterEach(cleanup);

describe("ReaderToolbar", () => {
  // Nearly every control here is an icon, so a missing label leaves a screen
  // reader user with a row of unnamed buttons.
  it("names every control it shows", () => {
    render(<Toolbar />);

    const unnamed = screen.queryAllByRole("button", {
      name: (name) => name.trim() === "",
    });
    expect(unnamed).toEqual([]);
    const actions = screen.getByRole("group", { name: "Thread actions" });
    for (const name of [
      "Expand all messages",
      "Archive",
      "Snooze",
      "Mark as unread",
      "More actions",
    ]) {
      expect(within(actions).getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByRole("button", { name: "Back to inbox" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Office hours",
    );
  });

  it("renames expand-all to collapse-all in place, keeping focus on it", () => {
    render(<Toolbar />);
    const toggle = screen.getByRole("button", { name: "Expand all messages" });
    toggle.focus();

    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "Collapse all messages" })).toBe(
      toggle,
    );
    expect(document.activeElement).toBe(toggle);
  });

  it("opens More actions from the keyboard and gives focus back on Escape", async () => {
    render(<Toolbar />);
    const trigger = screen.getByRole("button", { name: "More actions" });
    trigger.focus();

    fireEvent.keyDown(trigger, { key: "Enter" });
    const menu = await screen.findByRole("menu");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(menu.contains(document.activeElement)).toBe(true);
    expect(within(menu).getAllByRole("menuitem").length).toBeGreaterThan(1);

    fireEvent.keyDown(menu, { key: "Escape" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});

function Toolbar() {
  const [allExpanded, setAllExpanded] = useState(false);
  return (
    <ReaderToolbar
      isStarred={false}
      isUnread={false}
      labelHref={() => "/labels"}
      labels={[]}
      menu={
        <ThreadActionsMenu
          isStarred={false}
          message={null}
          onDelete={vi.fn()}
          onMarkSpam={vi.fn()}
          onToggleStar={vi.fn()}
        />
      }
      messageExpansion={{
        allExpanded,
        canExpand: true,
        onToggleAll: () => setAllExpanded((value) => !value),
      }}
      onArchive={vi.fn()}
      onBackToInbox={vi.fn()}
      onMarkRead={vi.fn()}
      onMarkUnread={vi.fn()}
      onSnooze={vi.fn()}
      subject="Office hours"
    />
  );
}
