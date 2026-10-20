// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";
import { CueFoundSection } from "./CueFoundSection";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/env", () => ({ env: {} }));

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", MockResizeObserver);

const INTENT = {
  searches: ["from:sarah has:attachment after:1788393600 (lease OR contract)"],
  editableSearches: [
    "from:sarah has:attachment after:2026/09/03 (lease OR contract)",
  ],
  unreadOnly: false,
  explanation: "Mail from Sarah with attachments in September",
  isQuestion: false,
  timeZone: "UTC",
};

afterEach(cleanup);

function renderSection(props: Partial<ComponentProps<typeof CueFoundSection>>) {
  const onEditSearch = vi.fn();
  render(
    <CueFoundSection
      expandedPreview={false}
      allInPlainResults={false}
      focusedIndex={-1}
      foundNothing={false}
      hasAnySelection={false}
      intent={INTENT}
      isSelected={() => false}
      layout="list"
      onEditSearch={onEditSearch}
      onOpen={vi.fn()}
      onSelectRangeTo={vi.fn()}
      onToggleSelect={vi.fn()}
      onToggleShowAll={vi.fn()}
      showAll={false}
      stage="done"
      threads={[]}
      totalCount={0}
      userEmail="david@example.com"
      userLabels={{}}
      widening={null}
      {...props}
    />,
  );
  return { onEditSearch };
}

describe("CueFoundSection", () => {
  it("says it's reading the search before Cue has", () => {
    renderSection({ stage: "reading", intent: null });
    expect(screen.getByRole("status").textContent).toBe("Reading your search…");
  });

  it("opens the searches Cue ran from its reading, to edit one", () => {
    const { onEditSearch } = renderSection({
      stage: "done",
      widening: {
        tier: "fewer_words",
        searches: ["from:sarah lease OR contract after:1788393600"],
      },
    });

    const reading = screen.getByRole("button", {
      name: /Mail from Sarah with attachments in September/,
    });
    expect(reading.textContent).toContain("searched with fewer words");
    fireEvent.click(reading);
    // The searches the tier ran sit under a line naming the tier.
    expect(
      screen.getByText(/found too little, so Cue searched with fewer words/),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", {
        name: "from:sarah lease OR contract after Sep 3, 2026",
      }),
    );

    expect(onEditSearch).toHaveBeenCalledWith(
      "from:sarah lease OR contract after:2026/09/03",
    );
    // Dates read as days in the user's locale, not the epoch seconds Gmail
    // is sent, while editing hands back a search the box can read.
    fireEvent.click(
      screen.getByRole("button", {
        name: "from:sarah has:attachment after Sep 3, 2026 (lease OR contract)",
      }),
    );
    expect(onEditSearch).toHaveBeenLastCalledWith(INTENT.editableSearches[0]);
  });

  it("says its searches found nothing only when told they all answered", () => {
    renderSection({ stage: "done" });
    expect(screen.queryByText("No mail matched Cue's searches.")).toBeNull();
    cleanup();
    renderSection({ stage: "done", foundNothing: true });
    expect(screen.getByText("No mail matched Cue's searches.")).toBeTruthy();
  });

  it("says where its matches are when the plain results already show them all", () => {
    renderSection({ stage: "done", allInPlainResults: true });
    expect(
      screen.getByText("Cue's matches are in the results below."),
    ).toBeTruthy();
  });

  it("shows the row under the cursor as focused, and selected rows as selected", () => {
    renderSection({
      threads: [thread("a"), thread("b")],
      totalCount: 2,
      focusedIndex: 1,
      isSelected: (key) => key.endsWith("a"),
    });

    const [first, second] = screen.getAllByRole("option");
    expect(first.getAttribute("aria-selected")).toBe("true");
    expect(second.getAttribute("aria-selected")).toBe("false");
    // The focused row is the one the keyboard can reach.
    expect(first.getAttribute("tabindex")).toBe("-1");
    expect(second.getAttribute("tabindex")).toBe("0");
  });

  it("opens, selects and range-selects rows by their place in the keyboard order", () => {
    const onOpen = vi.fn();
    const onToggleSelect = vi.fn();
    const onSelectRangeTo = vi.fn();
    renderSection({
      threads: [thread("a"), thread("b")],
      totalCount: 2,
      onOpen,
      onToggleSelect,
      onSelectRangeTo,
    });
    const [, second] = screen.getAllByRole("option");

    fireEvent.keyDown(second, { key: "Enter" });
    fireEvent.keyDown(second, { key: " " });
    fireEvent.keyDown(second, { key: " ", shiftKey: true });

    expect(onOpen).toHaveBeenCalledWith(1);
    expect(onToggleSelect).toHaveBeenCalledWith(1);
    expect(onSelectRangeTo).toHaveBeenCalledWith(1);
  });

  it("offers every row Cue found beyond the ones shown", () => {
    const onToggleShowAll = vi.fn();
    renderSection({
      threads: [thread("a"), thread("b"), thread("c")],
      totalCount: 5,
      onToggleShowAll,
    });

    fireEvent.click(screen.getByRole("button", { name: "Show all 5" }));
    expect(onToggleShowAll).toHaveBeenCalled();
  });

  it("closes when Cue has nothing to search", () => {
    renderSection({ stage: "off", intent: null });
    expect(screen.queryByRole("region", { name: "Cue found" })).toBeNull();
  });
});

function thread(id: string) {
  const received = new Date(2026, 9, 12, 18, 40);
  return {
    id,
    snippet: "Can you make Thursday?",
    messages: [
      {
        id: `${id}-message`,
        threadId: id,
        labelIds: ["INBOX"],
        snippet: "Can you make Thursday?",
        internalDate: String(received.getTime()),
        headers: {
          from: "kevin@example.com",
          to: "david@example.com",
          subject: `Office hours ${id}`,
          date: received.toISOString(),
        },
      },
    ],
  } as unknown as ListThread;
}
