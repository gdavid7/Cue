/** @vitest-environment jsdom */

import React, { useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadActionsMenu } from "@/app/(app)/[emailAccountId]/mail/ThreadActionsMenu";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

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
vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender", () => ({
  UnsubscribeConfirmDialog: () => null,
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
    unsubscribeConfirm: {},
  }),
}));

afterEach(cleanup);

describe("ThreadActionsMenu", () => {
  it("leaves focus in the comment box that Comment opens", async () => {
    render(<MenuWithCommentBox />);

    fireEvent.click(await screen.findByRole("menuitem", { name: /Comment/ }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Comment" }),
    );
  });

  // On a phone the bottom bar's More opens this menu; its own trigger is
  // hidden, so focus goes back to the button the user pressed.
  it("returns focus to the control that opened it from elsewhere", async () => {
    render(<MenuOpenedFromBar />);
    await screen.findByRole("menu");

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "More" }),
    );
  });
});

function MenuOpenedFromBar() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ThreadActionsMenu
        isStarred={false}
        message={null}
        onDelete={vi.fn()}
        onMarkSpam={vi.fn()}
        onOpenChange={setOpen}
        onToggleStar={vi.fn()}
        open={open}
        returnFocusTo={() =>
          document.querySelector<HTMLButtonElement>("[data-bar-more]")
        }
      />
      <button data-bar-more type="button">
        More
      </button>
    </>
  );
}

function MenuWithCommentBox() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <ThreadActionsMenu
        isStarred={false}
        message={null}
        onComment={() =>
          document.querySelector<HTMLTextAreaElement>("textarea")?.focus()
        }
        onDelete={vi.fn()}
        onMarkSpam={vi.fn()}
        onOpenChange={setOpen}
        onToggleStar={vi.fn()}
        open={open}
      />
      <textarea aria-label="Comment" />
    </>
  );
}
