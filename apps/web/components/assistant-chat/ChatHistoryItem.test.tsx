/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatHistoryItem } from "@/components/assistant-chat/ChatHistoryItem";
import type { ChatHistoryEntry } from "@/components/assistant-chat/chat-history-types";
import {
  DropdownMenu,
  DropdownMenuContent,
} from "@/components/ui/dropdown-menu";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

afterEach(() => {
  cleanup();
});

const chat = {
  id: "chat-1",
  name: "Project update",
  createdAt: new Date("2026-05-23T00:00:00.000Z"),
  updatedAt: new Date("2026-05-23T00:00:00.000Z"),
  emailAccountId: "email-account-1",
  email: "a@example.com",
  disconnected: false,
} satisfies ChatHistoryEntry;

describe("ChatHistoryItem", () => {
  // The history menu keeps Tab for itself, so the row's options button can't
  // be tabbed to; ArrowRight opens them, as it opens any submenu.
  it("opens the chat's options from the keyboard and returns to the row on Escape", async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuContent>
          <ChatHistoryItem
            chat={chat}
            onSelect={vi.fn()}
            onRename={vi.fn()}
            onDelete={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const row = screen.getByRole("menuitem", { name: /Project update/ });
    row.focus();

    fireEvent.keyDown(row, { key: "ArrowRight" });

    const rename = await screen.findByRole("menuitem", { name: /rename/i });
    expect(row.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(rename, { key: "Escape" });

    await waitFor(() =>
      expect(screen.queryByRole("menuitem", { name: /rename/i })).toBeNull(),
    );
    expect(document.activeElement).toBe(row);
  });

  it("keeps the actions menu open when the cursor leaves the chat row toward the actions", async () => {
    render(
      <DropdownMenu open={true}>
        <DropdownMenuContent>
          <ChatHistoryItem
            chat={chat}
            onSelect={vi.fn()}
            onRename={vi.fn()}
            onDelete={vi.fn()}
          />
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Chat options" }));

    expect(
      await screen.findByRole("menuitem", { name: /rename/i }),
    ).toBeTruthy();

    const chatMenuItem = screen
      .getByText("Project update")
      .closest('[role="menuitem"]');
    expect(chatMenuItem).toBeTruthy();

    fireEvent.pointerLeave(chatMenuItem!, {
      clientX: 100,
      clientY: 20,
      pointerType: "mouse",
    });

    expect(screen.getByRole("menuitem", { name: /rename/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /delete/i })).toBeTruthy();
  });
});
