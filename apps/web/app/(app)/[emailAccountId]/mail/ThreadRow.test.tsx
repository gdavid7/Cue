// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isFromImportantPerson,
  ThreadRow,
} from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import type { ThreadRowActionHandlers } from "@/app/(app)/[emailAccountId]/mail/ThreadRowActions";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { formatShortDate } from "@/utils/date";
import type { ThreadInsightData } from "@/utils/inbox-insights/get-inbox-insights";

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

  // Part of the option's own text, so a screen reader hears it with the row
  // and it adds no tab stop.
  it("says Cue drafted a reply when one is waiting", () => {
    renderRow({
      insightData: { insight: null, meeting: null, reply: "drafted" },
    });

    expect(
      screen.getByRole("option", { name: /Cue drafted a reply/ }),
    ).toBeTruthy();
    expect(screen.getByTestId("thread-insight").querySelector("button")).toBe(
      null,
    );
  });

  // One message delivered to two of the user's accounts shows as one row in
  // All inboxes, marked as Today marks it.
  it("says which other accounts a combined row's message is also in", () => {
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
        thread={
          {
            ...thread(),
            account: inbox("one@example.com"),
            alsoIn: [inbox("two@example.com"), inbox("three@example.com")],
          } as ListThread
        }
        userEmail="david@example.com"
        userLabels={{}}
      />,
    );

    expect(
      screen.getByText("Also in two@example.com, three@example.com"),
    ).toBeTruthy();
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

  it("leaves held, modified and bubbled Space presses alone", () => {
    const onToggleSelect = vi.fn();
    renderRow({ onToggleSelect });
    const row = screen.getByRole("option");

    fireEvent.keyDown(row, { key: " ", repeat: true });
    fireEvent.keyDown(row, { key: " ", metaKey: true });
    fireEvent.keyDown(row, { key: " ", ctrlKey: true });
    fireEvent.keyDown(row, { key: " ", altKey: true });
    fireEvent.keyDown(screen.getByText("Office hours"), {
      key: " ",
    });

    expect(onToggleSelect).not.toHaveBeenCalled();
  });

  // Focus stays on the row so J/K, Enter and Space carry on from there.
  it("keeps focus on the row when its checkbox is clicked", () => {
    renderRow();
    const row = screen.getByRole("option");
    row.focus();
    const checkbox = screen.getByRole("checkbox", { hidden: true });

    expect(fireEvent.mouseDown(checkbox)).toBe(false);
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

  it("marks mail from an important person, for screen readers too", () => {
    renderRow({ fromImportantPerson: true });

    expect(screen.getByTestId("important-person-marker")).toBeTruthy();
    expect(screen.getByRole("option").textContent).toContain(
      "From an important person",
    );
  });

  it("counts the people a conversation is from, not the user's own draft", () => {
    const starred = (accountId: string, from: string) =>
      accountId === "acc-1" && from === "david@example.com";

    expect(isFromImportantPerson(thread(), "acc-1", starred)).toBe(false);
    expect(
      isFromImportantPerson(
        thread(),
        "acc-1",
        (accountId, from) => accountId === "acc-1" && from.includes("kevin"),
      ),
    ).toBe(true);
    expect(
      isFromImportantPerson(
        thread(),
        "acc-2",
        (accountId, from) => accountId === "acc-1" && from.includes("kevin"),
      ),
    ).toBe(false);
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

describe("ThreadRow swipe", () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  // The hover actions' handlers are the toolbar's and the keyboard's, so a
  // swipe gets the same optimistic update, sync and Undo.
  it("archives on a touch swipe left, through the row's actions, without opening", async () => {
    const onOpen = vi.fn();
    const rowActions = actions();
    renderRow({ onOpen, rowActions });
    const row = screen.getByRole("option");

    swipe(row, "touch", [-20, -80, -160, -200]);
    fireEvent.click(row);

    await waitFor(() =>
      expect(rowActions.archive).toHaveBeenCalledWith("thread-1"),
    );
    expect(rowActions.setRead).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("marks an unread conversation read on a touch swipe right", () => {
    const rowActions = actions();
    renderRow({ rowActions, unread: true });

    swipe(screen.getByRole("option"), "touch", [20, 80, 160, 200]);

    expect(rowActions.setRead).toHaveBeenCalledWith("thread-1", true);
    expect(rowActions.archive).not.toHaveBeenCalled();
  });

  it("leaves a vertical scroll alone", () => {
    const onOpen = vi.fn();
    const rowActions = actions();
    renderRow({ onOpen, rowActions });
    const row = screen.getByRole("option");

    fireEvent.pointerDown(row, touchAt(200, 100));
    fireEvent.pointerMove(row, touchAt(190, 140));
    fireEvent.pointerMove(row, touchAt(60, 300));
    fireEvent.pointerUp(row, touchAt(60, 300));

    expect(rowActions.archive).not.toHaveBeenCalled();
    expect(rowActions.setRead).not.toHaveBeenCalled();
    expect(row.closest<HTMLElement>("[data-swiping]")).toBeNull();
  });

  it("archives once when the row is swiped again on its way out", async () => {
    const rowActions = actions();
    renderRow({ rowActions });
    const row = screen.getByRole("option");

    swipe(row, "touch", [-20, -80, -160, -200]);
    await waitFor(() => expect(rowActions.archive).toHaveBeenCalled());
    // Archived, but the list hasn't removed the row yet.
    swipe(row, "touch", [-20, -80, -160, -200]);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(rowActions.archive).toHaveBeenCalledTimes(1);
  });

  it("leaves a swipe from the screen's right edge to the browser", () => {
    const rowActions = actions();
    renderRow({ rowActions });
    const row = screen.getByRole("option");
    const edge = window.innerWidth - 4;

    fireEvent.pointerDown(row, touchAt(edge, 100));
    for (const dx of [-20, -80, -160, -200])
      fireEvent.pointerMove(row, touchAt(edge + dx, 100));
    fireEvent.pointerUp(row, touchAt(edge - 200, 100));

    expect(row.closest<HTMLElement>("[data-swiping]")).toBeNull();
    expect(rowActions.archive).not.toHaveBeenCalled();
  });

  it("never moves the row for a mouse drag", () => {
    const rowActions = actions();
    renderRow({ rowActions });

    swipe(screen.getByRole("option"), "mouse", [-20, -80, -160, -200]);

    expect(rowActions.archive).not.toHaveBeenCalled();
  });
});

function inbox(email: string) {
  return { id: email, email, name: null, image: null };
}

function swipe(row: HTMLElement, pointerType: string, xs: number[]) {
  const at = (dx: number) => ({
    pointerId: 1,
    isPrimary: true,
    pointerType,
    clientX: 200 + dx,
    clientY: 100,
  });
  fireEvent.pointerDown(row, at(0));
  for (const dx of xs) fireEvent.pointerMove(row, at(dx));
  fireEvent.pointerUp(row, at(xs.at(-1) ?? 0));
}

function touchAt(clientX: number, clientY: number) {
  return {
    pointerId: 1,
    isPrimary: true,
    pointerType: "touch",
    clientX,
    clientY,
  };
}

function actions() {
  return {
    archive: vi.fn(),
    moveToInbox: vi.fn(),
    trash: vi.fn(),
    setRead: vi.fn(),
    setStarred: vi.fn(),
    snooze: vi.fn(),
  };
}

function renderRow({
  onOpen = vi.fn(),
  onToggleSelect = vi.fn(),
  unread = false,
  insightData,
  rowActions,
  fromImportantPerson,
}: {
  onOpen?: (index: number) => void;
  onToggleSelect?: (index: number) => void;
  unread?: boolean;
  insightData?: ThreadInsightData;
  rowActions?: ThreadRowActionHandlers;
  fromImportantPerson?: boolean;
} = {}) {
  const base = thread();
  return render(
    <ThreadRow
      fromImportantPerson={fromImportantPerson}
      hasAnySelection={false}
      index={0}
      insightData={insightData}
      isFocused={false}
      isSelected={false}
      layout="list"
      onOpen={onOpen}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={onToggleSelect}
      rowActions={rowActions}
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
