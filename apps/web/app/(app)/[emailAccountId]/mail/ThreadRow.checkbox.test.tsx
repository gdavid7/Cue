// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRow } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";

vi.mock("@/env", () => ({ env: {} }));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

// Uses the real shortcut tooltip around the checkbox, which the other row
// tests stub out.
describe("ThreadRow selection checkbox", () => {
  afterEach(cleanup);

  it("moves focus to its row when clicked", () => {
    renderRow();

    clickCheckbox();

    expect(document.activeElement).toBe(screen.getByRole("option"));
  });

  // Escape after selecting clears the selection. A hint tooltip left open by
  // the click would take that Escape for itself.
  it("leaves the next Escape for the mail shortcuts", () => {
    renderRow();

    clickCheckbox();

    expect(fireEvent.keyDown(document.body, { key: "Escape" })).toBe(true);
  });
});

function clickCheckbox() {
  const checkbox = screen.getByRole("checkbox", { hidden: true });
  fireEvent.pointerDown(checkbox, { pointerType: "mouse" });
  fireEvent.mouseDown(checkbox);
  fireEvent.pointerUp(checkbox, { pointerType: "mouse" });
  fireEvent.mouseUp(checkbox);
  fireEvent.click(checkbox);
}

function renderRow() {
  const received = new Date(2026, 9, 12, 18, 40);
  const thread = {
    id: "thread-1",
    snippet: "Can you make Thursday?",
    messages: [
      {
        id: "received",
        threadId: "thread-1",
        labelIds: ["INBOX"],
        snippet: "Can you make Thursday?",
        internalDate: String(received.getTime()),
        headers: {
          from: "kevin@example.com",
          to: "david@example.com",
          subject: "Office hours",
          date: received.toISOString(),
        },
      },
    ],
  } as unknown as ListThread;

  return render(
    <ThreadRow
      hasAnySelection={false}
      index={0}
      isFocused={false}
      isSelected={false}
      layout="list"
      onOpen={vi.fn()}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={vi.fn()}
      thread={thread}
      userEmail="david@example.com"
      userLabels={{}}
    />,
  );
}
