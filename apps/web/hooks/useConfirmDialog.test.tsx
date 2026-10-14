// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConfirmDialog } from "@/hooks/useConfirmDialog";

afterEach(cleanup);

describe("useConfirmDialog", () => {
  it("resolves true only when the user picks the named action", async () => {
    const result = await runConfirm("Delete 3 emails");

    expect(result).toBe(true);
  });

  it("resolves false when the user cancels", async () => {
    const result = await runConfirm("Cancel");

    expect(result).toBe(false);
  });
});

async function runConfirm(buttonName: string) {
  let pending: Promise<boolean> | undefined;
  function Harness() {
    const { confirm, dialog } = useConfirmDialog();
    return (
      <>
        <button
          type="button"
          onClick={() => {
            pending = confirm({
              title: "Delete all emails from Kevin?",
              description: "They'll move to Trash.",
              confirmText: "Delete 3 emails",
            });
          }}
        >
          Start
        </button>
        {dialog}
      </>
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "Start" }));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
  });
  return pending;
}
