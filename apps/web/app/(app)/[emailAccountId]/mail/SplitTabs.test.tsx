/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SplitTabs } from "@/app/(app)/[emailAccountId]/mail/SplitTabs";

(globalThis as { React?: typeof React }).React = React;

class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as { ResizeObserver?: typeof MockResizeObserver }).ResizeObserver =
  MockResizeObserver;

afterEach(cleanup);

describe("SplitTabs", () => {
  it("deletes the open tab from its visible menu only after confirming", async () => {
    const onDelete = vi.fn();
    render(
      <SplitTabs
        activeSplitId="promos"
        canCreateSplits
        onDelete={onDelete}
        onEdit={vi.fn()}
        onNewSplit={vi.fn()}
        onSelect={vi.fn()}
        splits={[
          { id: "all", name: "All", deletable: false },
          { id: "promos", name: "Promos", deletable: true },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Options for the Promos tab",
    });
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Delete tab…" }),
    );

    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Delete tab" }));
    expect(onDelete).toHaveBeenCalledWith("promos");
  });

  it("gives built-in tabs no options to delete them", () => {
    render(
      <SplitTabs
        activeSplitId="all"
        canCreateSplits
        onDelete={vi.fn()}
        onNewSplit={vi.fn()}
        onSelect={vi.fn()}
        splits={[{ id: "all", name: "All", deletable: false }]}
      />,
    );

    expect(screen.queryByRole("button", { name: /Options for/ })).toBeNull();
  });
});
