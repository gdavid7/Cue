// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationState } from "@inboxzero/mail-core/operations";
import { Toaster, undoLatestToast } from "@/components/Toast";
import { setActiveMailClient } from "@/utils/mail-engine/active-client";
import { beginUndoSend, UNDO_SEND_DELAY_MS } from "./undo-send";

const server = vi.hoisted(() => ({ cancelHeldSendAction: vi.fn() }));
vi.mock("@/utils/actions/scheduled-email", () => server);
vi.mock("@/utils/redirect", () => ({ redirectToSafeUrl: vi.fn() }));

// The send's toast as undo-send drives it, through the real toasts.
describe("undo send's toast", () => {
  beforeEach(() => {
    server.cancelHeldSendAction.mockResolvedValue({
      data: { status: "unavailable" },
    });
    render(<Toaster />);
  });

  afterEach(() => {
    setActiveMailClient(null);
    toast.dismiss();
    cleanup();
  });

  it("keeps Undo when the server can't be reached within the hold", async () => {
    const engine = startSend({
      cancel: async () => ({ status: "unavailable" }),
    });

    fireEvent.click(await undoButton());
    await act(() => delay(50));

    expect(
      await screen.findByText("Couldn't reach the server to undo. Try again."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeTruthy();
    expect(engine.restoreComposer).not.toHaveBeenCalled();
  });

  it("stops offering Undo when the hold ends while an unanswered undo waits", async () => {
    startSend({
      holdMs: 100,
      cancel: async () => {
        await delay(200);
        return { status: "unavailable" };
      },
    });

    fireEvent.click(await undoButton());
    await act(() => delay(400));

    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    await expect(undoLatestToast()).resolves.toBe(false);
  });

  it("stops offering Undo, from the button and the shortcut, once the hold ends", async () => {
    const engine = startSend({ holdMs: 100 });
    await undoButton();

    await act(() => delay(300));

    expect(screen.getByText("Sending…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    await expect(undoLatestToast()).resolves.toBe(false);
    expect(engine.cancel).not.toHaveBeenCalled();
  });

  it("undoes once when Undo is pressed twice", async () => {
    const engine = startSend({
      cancel: async () => {
        await delay(50);
        return { status: "cancelled", revision: 1 };
      },
    });
    const undo = await undoButton();

    fireEvent.click(undo);
    fireEvent.click(undo);
    await act(() => delay(400));

    expect(engine.cancel).toHaveBeenCalledOnce();
    expect(engine.restoreComposer).toHaveBeenCalledOnce();
    expect(screen.getByText("Send undone. Draft restored.")).toBeTruthy();
  });

  it("still confirms the undo when putting the draft back fails", async () => {
    const engine = startSend();
    engine.restoreComposer.mockImplementation(() => {
      throw new Error("composer gone");
    });

    fireEvent.click(await undoButton());
    await act(() => delay(400));

    expect(
      screen.getByText(
        "Send undone. Couldn't reopen the draft — it's saved on this device.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
    await expect(undoLatestToast()).resolves.toBe(false);
  });

  it("reports a send that went out while an unanswered undo waited", async () => {
    const engine = startSend({
      cancel: async () => {
        await delay(100);
        return { status: "unavailable" };
      },
    });

    fireEvent.click(await undoButton());
    await act(() => delay(20));
    engine.setStatus("succeeded");
    await act(() => delay(300));

    expect(screen.getByText("Sent")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Undo/ })).toBeNull();
  });
});

function startSend({
  holdMs = UNDO_SEND_DELAY_MS,
  cancel = async () => ({ status: "cancelled", revision: 1 }),
}: {
  holdMs?: number;
  cancel?: () => Promise<unknown>;
} = {}) {
  let operation: OperationState = {
    key: { accountId: "account", operationId: "mutation" },
    status: "executing",
    authority: "backend",
    attempts: 1,
    nextAttemptAtMs: null,
    error: null,
  };
  let listener = () => {};
  const cancelOperation = vi.fn(cancel);
  const client = {
    cancelOperation,
    observeOperation: () => ({
      getSnapshot: () => ({
        status: "ready",
        revision: null,
        data: operation,
        refreshing: false,
        error: null,
      }),
      subscribe: (next: () => void) => {
        listener = next;
        return () => {};
      },
      close: () => {},
    }),
    readDraft: async () => ({ status: "found" }),
  } as unknown as MailClient;
  const restoreComposer = vi.fn();
  setActiveMailClient(client);
  act(() => {
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + holdMs,
      restoreComposer,
    });
  });
  return {
    cancel: cancelOperation,
    restoreComposer,
    setStatus(status: OperationState["status"]) {
      operation = { ...operation, status };
      listener();
    },
  };
}

function undoButton() {
  return screen.findByRole("button", { name: /^Undo/ });
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
