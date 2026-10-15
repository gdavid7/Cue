// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRow } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { formatShortDate } from "@/utils/date";

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/components/Tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
}));

const RECEIVED = new Date(2026, 9, 12, 18, 40);
const DRAFTED = new Date(2026, 9, 13, 23, 26);

describe("ThreadRow", () => {
  afterEach(cleanup);

  // Like Gmail: the row marks the draft but still shows what was received.
  it("keeps the sender's message and time when the user has a draft", () => {
    render(
      <ThreadRow
        hasAnySelection={false}
        index={0}
        isFocused={false}
        isSelected={false}
        layout="list"
        onOpen={vi.fn()}
        onSelectRangeTo={vi.fn()}
        onToggleSelect={vi.fn()}
        thread={thread()}
        userEmail="david@example.com"
        userLabels={{}}
      />,
    );

    expect(screen.getByText("Can you make Thursday?")).toBeTruthy();
    expect(screen.queryByText(/Yes, Thursday works/)).toBeNull();
    expect(screen.getByText(formatShortDate(RECEIVED))).toBeTruthy();
    expect(screen.queryByText(formatShortDate(DRAFTED))).toBeNull();
    expect(screen.getByText("Draft")).toBeTruthy();
  });

  it("keeps the select checkbox out of the tab order", () => {
    renderRow();

    expect(
      screen.getByRole("checkbox", { hidden: true }).getAttribute("tabindex"),
    ).toBe("-1");
  });

  // The option's aria-selected already says whether it is selected; a
  // checkbox inside it only prefixed every row's name with "Select…".
  it("names the row by its conversation, with the checkbox still clickable", () => {
    const onToggleSelect = vi.fn();
    renderRow({ onToggleSelect });

    expect(screen.queryByRole("option", { name: /Select/ })).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { hidden: true }));
    expect(onToggleSelect).toHaveBeenCalledWith(0);
  });

  it("toggles selection with Space on the focused row, like a listbox", () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    renderRow({ onOpen, onToggleSelect });

    fireEvent.keyDown(screen.getByRole("option"), { key: " " });

    expect(onToggleSelect).toHaveBeenCalledWith(0);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // Children of role="option" are presentational, so buttons inside it have
  // no role or name for assistive tech.
  it("exposes the row's hover actions as named buttons outside the option", () => {
    render(
      <ThreadRow
        hasAnySelection={false}
        index={0}
        isFocused={false}
        isSelected={false}
        layout="list"
        onOpen={vi.fn()}
        onSelectRangeTo={vi.fn()}
        onToggleSelect={vi.fn()}
        rowActions={{
          archive: vi.fn(),
          moveToInbox: vi.fn(),
          trash: vi.fn(),
          setRead: vi.fn(),
          setStarred: vi.fn(),
          snooze: vi.fn(),
        }}
        thread={thread()}
        userEmail="david@example.com"
        userLabels={{}}
      />,
    );

    const archive = screen.getByRole("button", {
      name: "Archive conversation",
    });
    expect(screen.getByRole("option").contains(archive)).toBe(false);
  });

  it("announces an unread conversation, not only by weight", () => {
    renderRow({ unread: true });

    expect(screen.getByRole("option").textContent).toContain("Unread");
  });

  it("selects on a touch hold without also opening the conversation", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    renderRow({ onOpen, onToggleSelect });
    const row = screen.getByRole("option");

    fireEvent.pointerDown(row, {
      pointerType: "touch",
      clientX: 5,
      clientY: 5,
    });
    act(() => vi.advanceTimersByTime(600));
    fireEvent.pointerUp(row, { pointerType: "touch" });
    fireEvent.click(row);

    expect(onToggleSelect).toHaveBeenCalledWith(0);
    expect(onOpen).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("still opens on a quick tap", () => {
    vi.useFakeTimers();
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    renderRow({ onOpen, onToggleSelect });
    const row = screen.getByRole("option");

    fireEvent.pointerDown(row, {
      pointerType: "touch",
      clientX: 5,
      clientY: 5,
    });
    act(() => vi.advanceTimersByTime(100));
    fireEvent.pointerUp(row, { pointerType: "touch" });
    fireEvent.click(row);

    expect(onOpen).toHaveBeenCalledWith(0);
    expect(onToggleSelect).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

function renderRow({
  onOpen = vi.fn(),
  onToggleSelect = vi.fn(),
  unread = false,
}: {
  onOpen?: (index: number) => void;
  onToggleSelect?: (index: number) => void;
  unread?: boolean;
} = {}) {
  const base = thread();
  return render(
    <ThreadRow
      hasAnySelection={false}
      index={0}
      isFocused={false}
      isSelected={false}
      layout="list"
      onOpen={onOpen}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={onToggleSelect}
      thread={
        {
          ...base,
          messages: [
            {
              ...base.messages[0],
              labelIds: unread ? ["INBOX", "UNREAD"] : ["INBOX"],
            },
          ],
        } as ListThread
      }
      userEmail="david@example.com"
      userLabels={{}}
    />,
  );
}

function thread(): ListThread {
  return {
    id: "thread-1",
    // The provider's thread snippet follows its newest message, the draft.
    snippet: "Yes, Thursday works for me.",
    messages: [
      message(
        "received",
        "kevin@example.com",
        RECEIVED,
        "Can you make Thursday?",
        ["INBOX"],
      ),
      message(
        "draft",
        "david@example.com",
        DRAFTED,
        "Yes, Thursday works for me.",
        ["DRAFT"],
      ),
    ],
  } as unknown as ListThread;
}

function message(
  id: string,
  from: string,
  date: Date,
  snippet: string,
  labelIds: string[],
) {
  return {
    id,
    threadId: "thread-1",
    labelIds,
    snippet,
    internalDate: String(date.getTime()),
    headers: {
      from,
      to: "david@example.com",
      subject: "Office hours",
      date: date.toISOString(),
    },
  };
}
