// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxThreadList } from "@inboxzero/mail-ui/MailboxSurface";
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
