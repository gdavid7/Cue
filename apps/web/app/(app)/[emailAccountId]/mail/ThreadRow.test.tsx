// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
});

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
