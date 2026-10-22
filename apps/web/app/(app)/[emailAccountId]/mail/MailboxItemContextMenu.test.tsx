// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxItemContextMenu } from "@/app/(app)/[emailAccountId]/mail/MailboxItemContextMenu";

describe("MailboxItemContextMenu focus", () => {
  afterEach(cleanup);

  it("returns focus to the options button after a dialog from the options menu closes", async () => {
    renderMenu();
    const options = optionsButton();

    await openOptionsMenu(options);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "label name" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(document.activeElement).toBe(options));
  });

  // A dialog opened by right click used to leave the options menu thinking it
  // had opened one, so its next close dropped focus on the page.
  it("still returns focus to the options button when its menu closes after a right-click edit", async () => {
    renderMenu();
    const options = optionsButton();

    fireEvent.contextMenu(screen.getByRole("link", { name: "Receipts" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(document.activeElement).toBe(options));

    await openOptionsMenu(options);
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("menuitem", { name: "Edit" }),
      ),
    );
    fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });

    await waitFor(() => expect(document.activeElement).toBe(options));
  });
});

function renderMenu() {
  render(
    <MailboxItemContextMenu
      item={{ id: "label-1", kind: "label", name: "Receipts" }}
      typeName="label"
      editMode="name"
      onEdit={vi.fn().mockResolvedValue(true)}
      onDelete={vi.fn().mockResolvedValue(true)}
    >
      <a href="/mail/label/receipts">Receipts</a>
    </MailboxItemContextMenu>,
  );
}

function optionsButton() {
  return screen.getByRole("button", { name: "Label options for Receipts" });
}

async function openOptionsMenu(button: HTMLElement) {
  await act(async () => {
    button.focus();
    fireEvent.keyDown(button, { key: "Enter" });
  });
}
