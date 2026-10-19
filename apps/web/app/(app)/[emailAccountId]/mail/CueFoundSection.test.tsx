// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CueFoundSection } from "./CueFoundSection";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

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
      foundNothing={false}
      intent={INTENT}
      layout="list"
      onEditSearch={onEditSearch}
      onOpenThread={vi.fn()}
      stage="done"
      threads={[]}
      userEmail="david@example.com"
      userLabels={{}}
      widerSearches={[]}
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
      widerSearches: ["from:sarah lease OR contract after:1788393600"],
    });

    const reading = screen.getByRole("button", {
      name: /Mail from Sarah with attachments in September/,
    });
    expect(reading.textContent).toContain("searched more widely");
    fireEvent.click(reading);
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

  it("closes when Cue has nothing to search", () => {
    renderSection({ stage: "off", intent: null });
    expect(screen.queryByRole("region", { name: "Cue found" })).toBeNull();
  });
});
