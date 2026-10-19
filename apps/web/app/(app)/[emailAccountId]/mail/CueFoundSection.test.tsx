// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CueFoundSection } from "./CueFoundSection";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));

const INTENT = {
  searches: ["from:sarah has:attachment after:2026/09/01 lease OR contract"],
  explanation: "Mail from Sarah with attachments in September",
  isQuestion: false,
};

afterEach(cleanup);

function renderSection(props: Partial<ComponentProps<typeof CueFoundSection>>) {
  const onEditSearch = vi.fn();
  render(
    <CueFoundSection
      expandedPreview={false}
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
      widerSearches: ["from:sarah lease OR contract"],
    });

    const reading = screen.getByRole("button", {
      name: /Mail from Sarah with attachments in September/,
    });
    expect(reading.textContent).toContain("searched more widely");
    fireEvent.click(reading);
    fireEvent.click(
      screen.getByRole("button", { name: "from:sarah lease OR contract" }),
    );

    expect(onEditSearch).toHaveBeenCalledWith("from:sarah lease OR contract");
    expect(
      screen.getByRole("button", { name: INTENT.searches[0] }),
    ).toBeTruthy();
  });

  it("says when its searches found nothing, only once they have", () => {
    renderSection({ stage: "searching" });
    expect(screen.queryByText("No mail matched Cue's searches.")).toBeNull();
    cleanup();
    renderSection({ stage: "done" });
    expect(screen.getByText("No mail matched Cue's searches.")).toBeTruthy();
  });
});
