// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu";

afterEach(cleanup);

describe("ContextMenuContent", () => {
  it("does not select the item under the pointer when the opening right-click is released", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    openMenu();
    const edit = screen.getByRole("menuitem", { name: "Edit" });
    fireEvent.pointerUp(edit, { button: 2, pointerType: "mouse" });

    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("selects on release once the pointer has dragged onto an item", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    openMenu();
    const edit = screen.getByRole("menuitem", { name: "Edit" });
    fireEvent(edit, pointerMove({ movementX: 6, movementY: 8 }));
    fireEvent.pointerUp(edit, { button: 2, pointerType: "mouse" });

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("guards each opening of the menu separately", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    openMenu();
    fireEvent(document, pointerMove({ movementX: 20, movementY: 0 }));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    openMenu();
    fireEvent.pointerUp(screen.getByRole("menuitem", { name: "Edit" }), {
      button: 2,
      pointerType: "mouse",
    });

    expect(onSelect).not.toHaveBeenCalled();
  });

  it("still selects an item that is clicked", () => {
    const onSelect = vi.fn();
    renderMenu(onSelect);

    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

function renderMenu(onSelect: () => void) {
  render(
    <ContextMenu>
      <ContextMenuTrigger>Label</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>Edit</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>,
  );
}

function openMenu() {
  fireEvent.contextMenu(screen.getByText("Label"), {
    clientX: 40,
    clientY: 600,
  });
}

// jsdom's MouseEvent ignores movementX/Y, which the guard measures travel by.
function pointerMove({
  movementX,
  movementY,
}: {
  movementX: number;
  movementY: number;
}) {
  const event = new MouseEvent("pointermove", { bubbles: true });
  Object.defineProperties(event, {
    movementX: { value: movementX },
    movementY: { value: movementY },
  });
  return event;
}
