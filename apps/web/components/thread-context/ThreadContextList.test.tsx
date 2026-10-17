// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadContextList } from "@/components/thread-context/ThreadContextList";

vi.mock("@/hooks/useThreadContext", () => ({
  useThreadContext: () => ({
    data: {
      items: [
        {
          id: "thread-2",
          kind: "email",
          title: "Office hours moved",
          snippet: "",
          at: new Date().toISOString(),
          reasons: [],
        },
      ],
    },
  }),
}));

afterEach(cleanup);

describe("ThreadContextList", () => {
  it("heads the list at h3 unless told where it sits", () => {
    renderList();

    expect(
      screen.getByRole("heading", { level: 3, name: "Related" }),
    ).toBeTruthy();
  });

  // Inside a message that is itself an h3, beside the mail list.
  it("heads the list at the level asked for, so no level is skipped", () => {
    renderList(4);

    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(
      screen.getByRole("heading", { level: 4, name: "Related" }),
    ).toBeTruthy();
  });
});

function renderList(headingLevel?: 3 | 4) {
  return render(
    <ThreadContextList
      emailAccountId="account-1"
      heading="Related"
      headingLevel={headingLevel}
      onOpenThread={vi.fn()}
      threadId="thread-1"
    />,
  );
}
