// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxThreadList } from "@inboxzero/mail-ui/MailboxSurface";

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
});

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
