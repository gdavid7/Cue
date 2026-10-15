// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxThreadList } from "@inboxzero/mail-ui/MailboxSurface";
import { MailThreadRow } from "@inboxzero/mail-ui/MailThreadRow";
import { ThreadList } from "./ThreadList";
import type { ListThread } from "./types";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "acc-1" }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/hooks/useInboxInsights", () => ({
  useInboxInsights: () => ({ data: undefined }),
}));
vi.mock("@/hooks/useSentMessageOpens", () => ({
  useSentMessageOpensForThreads: () => ({ data: undefined }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/ThreadRow", () => ({
  ThreadRow: ({ thread }: { thread: { id: string } }) => <div>{thread.id}</div>,
}));

type Item = { id: string; day: string };

describe("mailbox thread list", () => {
  afterEach(cleanup);

  // Archiving a conversation must only remove its row. Remounting every
  // later day's rows made each archive re-create most of the list.
  it("keeps later days' rows mounted when an earlier row goes", () => {
    const items: Item[] = [
      { id: "a", day: "Today" },
      { id: "b", day: "Today" },
      { id: "c", day: "Yesterday" },
      { id: "d", day: "Mon, Oct 12" },
    ];
    const { rerender } = render(list(items));
    const yesterday = screen.getByTestId("c");
    const earlier = screen.getByTestId("d");

    rerender(list(items.filter((item) => item.id !== "a")));

    expect(screen.queryByTestId("a")).toBeNull();
    expect(screen.getByTestId("c")).toBe(yesterday);
    expect(screen.getByTestId("d")).toBe(earlier);
  });

  // Screen readers follow DOM focus, and Enter is handled by the focused row,
  // so moving only the highlight left both on the first conversation.
  it("moves focus with the highlight and opens the highlighted row on Enter", () => {
    const onOpen = vi.fn();
    render(<KeyboardList onOpen={onOpen} />);
    screen.getByRole("option", { name: /First/ }).focus();

    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });
    fireEvent.keyDown(document.activeElement as Element, { key: "ArrowDown" });

    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: /Third/ }),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith(2);
  });

  it("leaves focus outside the list where it is", () => {
    const search = document.createElement("input");
    document.body.append(search);
    const { rerender } = render(<RowList focusedIndex={0} />);
    screen.getByRole("option", { name: /First/ }).focus();
    search.focus();

    rerender(<RowList focusedIndex={2} />);

    expect(document.activeElement).toBe(search);
    search.remove();
  });

  // Archiving the focused row removes it, which drops focus to the page;
  // J/K and Enter then had nothing to act on until the user clicked a row.
  it("focuses the next row when the focused row goes", () => {
    const { rerender } = render(<RowList focusedIndex={1} />);
    screen.getByRole("option", { name: /Second/ }).focus();

    rerender(
      <RowList
        focusedIndex={1}
        items={ITEMS.filter((item) => item.id !== "Second")}
      />,
    );

    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: /Third/ }),
    );
  });
});

describe("ThreadList", () => {
  it("leaves day groups out of server HTML, which knows no viewer's timezone", () => {
    const lastWeek = Date.now() - 7 * 24 * 60 * 60 * 1000;

    const html = renderToString(
      <ThreadList
        expandedPreview={false}
        focusedIndex={-1}
        isLoadingMore={false}
        isSelected={() => false}
        layout="list"
        listKey="inbox"
        onLoadMore={vi.fn()}
        onOpenThread={vi.fn()}
        onSelectRangeTo={vi.fn()}
        onToggleSelect={vi.fn()}
        selectedCount={0}
        showLoadMore={false}
        threads={[threadAt("t1", lastWeek)]}
        userEmail="me@example.com"
        userLabels={{}}
      />,
    );

    expect(html).toContain("t1");
    // A day group carries its label as the group's accessible name.
    expect(html).not.toMatch(/<div aria-label="[^"]+" role="group"/);
  });
});

const ITEMS: Item[] = [
  { id: "First", day: "Today" },
  { id: "Second", day: "Today" },
  { id: "Third", day: "Yesterday" },
];

function KeyboardList({ onOpen }: { onOpen: (index: number) => void }) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  return (
    // Stands in for the app's global J/K/arrow shortcuts.
    <div
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") {
          setFocusedIndex((index) => Math.min(index + 1, ITEMS.length - 1));
        }
      }}
    >
      <RowList focusedIndex={focusedIndex} onOpen={onOpen} />
    </div>
  );
}

function RowList({
  focusedIndex,
  items = ITEMS,
  onOpen = vi.fn(),
}: {
  focusedIndex: number;
  items?: Item[];
  onOpen?: (index: number) => void;
}) {
  return (
    <MailboxThreadList<Item>
      focusedIndex={focusedIndex}
      getGroupLabel={(item) => item.day}
      getKey={(item) => item.id}
      isLoadingMore={false}
      isSelected={() => false}
      items={items}
      listKey="inbox"
      onLoadMore={vi.fn()}
      onOpen={onOpen}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={vi.fn()}
      renderItem={(row) => (
        <MailThreadRow
          date="Oct 14"
          hasAnySelection={false}
          index={row.index}
          isDraft={false}
          isFocused={row.isFocused}
          isSelected={row.isSelected}
          isStarred={false}
          isUnread={false}
          key={row.rowKey}
          layout="list"
          messageCount={1}
          onOpen={row.onOpen}
          onSelectRangeTo={row.onSelectRangeTo}
          onToggleSelect={row.onToggleSelect}
          participantSummary="Alice"
          rowRef={row.rowRef}
          snippet="Hello"
          subject={row.item.id}
        />
      )}
      selectedCount={0}
      showLoadMore={false}
    />
  );
}

function threadAt(id: string, receivedAtMs: number) {
  return {
    id,
    snippet: "",
    messages: [
      {
        id: `${id}-m`,
        threadId: id,
        internalDate: String(receivedAtMs),
        date: new Date(receivedAtMs).toISOString(),
        labelIds: ["INBOX"],
        headers: { from: "a@example.com", to: "me@example.com", subject: id },
      },
    ],
  } as unknown as ListThread;
}

function list(items: Item[]) {
  return (
    <MailboxThreadList<Item>
      focusedIndex={0}
      getGroupLabel={(item) => item.day}
      getKey={(item) => item.id}
      isLoadingMore={false}
      isSelected={() => false}
      items={items}
      listKey="inbox"
      onLoadMore={vi.fn()}
      onOpen={vi.fn()}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={vi.fn()}
      renderItem={(row) => (
        <div data-testid={row.item.id} key={row.rowKey}>
          {row.item.id}
        </div>
      )}
      selectedCount={0}
      showLoadMore={false}
    />
  );
}
