// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import {
  Toaster,
  toastSending,
  toastSendUndone,
  undoLatestToast,
} from "./Toast";

// Longer than sonner's exit animation, after which a closing toast is removed.
const EXIT_WINDOW_MS = 400;

afterEach(() => {
  // Sonner keeps toasts across Toaster mounts, so each test starts empty.
  toast.dismiss();
  cleanup();
});

describe("the send's toast", () => {
  it("confirms an undo from the Undo button that lands while the toast would be closing", async () => {
    render(<Toaster />);
    const id = "undo-send:click";
    act(() => {
      toastSending({
        id,
        hold: {
          durationMs: 10_000,
          onUndo: async () => {
            await delay(50);
            toastSendUndone(id);
          },
        },
      });
    });

    fireEvent.click(await screen.findByRole("button", { name: /Undo/ }));
    await act(() => delay(EXIT_WINDOW_MS));

    expect(screen.getByText("Send undone. Draft restored.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Undo/ })).toBeNull();
  });

  it("confirms an undo from the keyboard that lands while the toast would be closing", async () => {
    render(<Toaster />);
    const id = "undo-send:keyboard";
    act(() => {
      toastSending({
        id,
        hold: {
          durationMs: 10_000,
          onUndo: async () => {
            await delay(80);
            toastSendUndone(id);
          },
        },
      });
    });
    await screen.findByRole("button", { name: /Undo/ });

    await act(async () => {
      await expect(undoLatestToast()).resolves.toBe(true);
    });
    await act(() => delay(EXIT_WINDOW_MS));

    expect(screen.getByText("Send undone. Draft restored.")).toBeTruthy();
  });
});

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
