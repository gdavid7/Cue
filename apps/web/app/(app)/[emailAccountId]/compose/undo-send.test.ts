import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationState } from "@inboxzero/mail-core/operations";
import type { QueryHandle } from "@inboxzero/mail-core/queries";
import { setActiveMailClient } from "@/utils/mail-engine/active-client";
import {
  beginUndoSend,
  getUndoSendHoldUntil,
  undoPendingSend,
  UNDO_SEND_DELAY_MS,
} from "./undo-send";

const notifications = vi.hoisted(() => ({
  dismiss: vi.fn(),
  toastError: vi.fn(),
  toastSending: vi.fn(),
  toastSendFailed: vi.fn(),
  toastSendUndone: vi.fn(),
  toastSent: vi.fn(),
}));

vi.mock("@/components/Toast", () => notifications);
vi.mock("sonner", () => ({
  toast: { dismiss: notifications.dismiss },
}));
vi.mock("@/lib/shortcuts/registry", () => ({
  getShortcutHint: () => "z",
}));

const server = vi.hoisted(() => ({
  cancelHeldSendAction: vi.fn(),
}));
vi.mock("@/utils/actions/scheduled-email", () => server);

describe("undo send", () => {
  beforeEach(async () => {
    await undoPendingSend();
    vi.clearAllMocks();
    server.cancelHeldSendAction.mockResolvedValue({
      data: { status: "cancelled" },
    });
  });

  afterEach(() => {
    setActiveMailClient(null);
    vi.useRealTimers();
  });

  it("follows the engine that replaced the one the send was queued on", async () => {
    const restoreComposer = vi.fn();
    const replaced = createClient();
    const next = createClient();
    setActiveMailClient(replaced.client);
    beginUndoSend({
      client: replaced.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    // A retry or another tab taking over replaces the engine on the same mailbox.
    setActiveMailClient(next.client);
    expect(replaced.handle.close).toHaveBeenCalled();
    next.handle.set("succeeded");

    expect(notifications.toastSent).toHaveBeenCalledWith("undo-send:mutation");
    await expect(undoPendingSend()).resolves.toBe(false);
    expect(replaced.cancel).not.toHaveBeenCalled();
  });

  it("undoes through the engine that replaced the one the send was queued on", async () => {
    const restoreComposer = vi.fn();
    const replaced = createClient();
    const next = createClient();
    setActiveMailClient(replaced.client);
    beginUndoSend({
      client: replaced.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    setActiveMailClient(next.client);

    await expect(undoPendingSend()).resolves.toBe(true);
    expect(next.cancel).toHaveBeenCalledWith({
      accountId: "account-a",
      operationId: "mutation",
    });
    expect(replaced.cancel).not.toHaveBeenCalled();
    expect(server.cancelHeldSendAction).not.toHaveBeenCalled();
    expect(restoreComposer).toHaveBeenCalledOnce();
    expect(notifications.toastSendUndone).toHaveBeenCalledWith(
      "undo-send:mutation",
    );
  });

  it("cancels on the server when no engine is running after a switch", async () => {
    const restoreComposer = vi.fn();
    const closed = createClient();
    beginUndoSend({
      client: closed.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    setActiveMailClient(null);

    await expect(undoPendingSend()).resolves.toBe(true);
    expect(server.cancelHeldSendAction).toHaveBeenCalledOnce();
    expect(closed.cancel).not.toHaveBeenCalled();
    expect(restoreComposer).toHaveBeenCalledOnce();
  });

  it("falls back to the server when the engine never answers", async () => {
    vi.useFakeTimers();
    const restoreComposer = vi.fn();
    const hung = createClient();
    hung.cancel.mockReturnValue(new Promise(() => {}));
    setActiveMailClient(hung.client);
    beginUndoSend({
      client: hung.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    const undone = undoPendingSend();
    await vi.advanceTimersByTimeAsync(UNDO_SEND_DELAY_MS);

    await expect(undone).resolves.toBe(true);
    expect(server.cancelHeldSendAction).toHaveBeenCalledWith("account-a", {
      operationId: "mutation",
    });
    expect(restoreComposer).toHaveBeenCalledOnce();
  });

  it("reports a failed server undo instead of leaving it pending", async () => {
    const restoreComposer = vi.fn();
    beginUndoSend({
      client: createClient().client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    server.cancelHeldSendAction.mockRejectedValue(new Error("offline"));

    await expect(undoPendingSend()).resolves.toBe(false);
    expect(restoreComposer).not.toHaveBeenCalled();
    expect(notifications.toastError).toHaveBeenCalledWith({
      description: "Couldn't reach the server to undo. Try again.",
    });
  });

  it("holds online sends for 10 seconds and skips the delay when offline", () => {
    expect(getUndoSendHoldUntil(false, 1000)).toBeUndefined();
    expect(getUndoSendHoldUntil(true, 1000)).toBe(11_000);
  });

  it("restores the composer when undo cancels a held send", async () => {
    const restoreComposer = vi.fn();
    const { client, handle } = activeClient();
    const holdUntil = Date.now() + UNDO_SEND_DELAY_MS;
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil,
      restoreComposer,
    });

    const toast = notifications.toastSending.mock.calls[0]?.[0];
    expect(toast).toEqual({
      id: "undo-send:mutation",
      hold: {
        durationMs: expect.any(Number),
        onUndo: expect.any(Function),
        shortcut: "z",
      },
    });
    expect(toast.hold.durationMs).toBeGreaterThan(0);
    expect(toast.hold.durationMs).toBeLessThanOrEqual(UNDO_SEND_DELAY_MS);
    await expect(undoPendingSend()).resolves.toBe(true);
    expect(client.cancelOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: "mutation",
    });
    expect(restoreComposer).toHaveBeenCalledOnce();
    expect(notifications.toastSendUndone).toHaveBeenCalledWith(
      "undo-send:mutation",
    );
    expect(handle.close).toHaveBeenCalled();
    await expect(undoPendingSend()).resolves.toBe(false);
  });

  it("does not offer undo after the hold has already expired", () => {
    beginUndoSend({
      client: createClient().client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() - 1,
      restoreComposer: vi.fn(),
    });

    expect(notifications.toastSending).not.toHaveBeenCalled();
  });

  it("keeps undo open while the server holds the send", async () => {
    const restoreComposer = vi.fn();
    const { client, handle } = activeClient();
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    handle.set("executing");
    handle.set("verifying");

    expect(notifications.dismiss).not.toHaveBeenCalled();
    await expect(undoPendingSend()).resolves.toBe(true);
    expect(client.cancelOperation).toHaveBeenCalledOnce();
    expect(restoreComposer).toHaveBeenCalledOnce();
  });

  it("reports the send once it has gone out", async () => {
    const restoreComposer = vi.fn();
    const { client, handle } = activeClient();
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    handle.set("succeeded");

    expect(notifications.toastSent).toHaveBeenCalledWith("undo-send:mutation");
    expect(notifications.dismiss).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
    await expect(undoPendingSend()).resolves.toBe(false);
    expect(client.cancelOperation).not.toHaveBeenCalled();
    expect(restoreComposer).not.toHaveBeenCalled();
    expect(notifications.toastError).not.toHaveBeenCalled();
  });

  it("keeps a failed send open with a way back to the draft", () => {
    const restoreComposer = vi.fn();
    const { client, handle } = activeClient();
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    handle.set("failed");

    expect(notifications.toastSendFailed).toHaveBeenCalledWith({
      id: "undo-send:mutation",
      onRetry: restoreComposer,
    });
    expect(notifications.dismiss).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalled();
  });

  it("drops undo when the hold elapses and reports the send after it", async () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const { client, handle } = activeClient();
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: now + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(UNDO_SEND_DELAY_MS);

    expect(notifications.toastSending).toHaveBeenLastCalledWith({
      id: "undo-send:mutation",
    });
    await expect(undoPendingSend()).resolves.toBe(false);
    expect(client.cancelOperation).not.toHaveBeenCalled();

    handle.set("succeeded");
    expect(notifications.toastSent).toHaveBeenCalledWith("undo-send:mutation");
    expect(handle.close).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not dismiss a later send's undo when an earlier hold elapses", async () => {
    vi.useFakeTimers();
    const now = 1_000_000;
    vi.setSystemTime(now);
    const first = activeClient();
    const second = activeClient();
    beginUndoSend({
      client: first.client,
      operationId: "first",
      emailAccountId: "account",
      holdUntil: now + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(4000);
    beginUndoSend({
      client: second.client,
      operationId: "second",
      emailAccountId: "account",
      holdUntil: now + 4000 + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
    });
    expect(first.handle.close).toHaveBeenCalled();
    expect(notifications.dismiss).toHaveBeenCalledWith("undo-send:first");
    expect(notifications.toastSending.mock.calls[1]?.[0]?.id).toBe(
      "undo-send:second",
    );
    notifications.dismiss.mockClear();

    await vi.advanceTimersByTimeAsync(1000);
    expect(notifications.dismiss).not.toHaveBeenCalled();
    expect(second.handle.close).not.toHaveBeenCalled();

    await notifications.toastSending.mock.calls[0]?.[0]?.hold.onUndo();
    expect(second.client.cancelOperation).not.toHaveBeenCalled();

    await expect(undoPendingSend()).resolves.toBe(true);
    expect(second.client.cancelOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: "second",
    });
    expect(first.client.cancelOperation).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("does not restore when the send has already started", async () => {
    const restoreComposer = vi.fn();
    const { client } = activeClient({ cancelStatus: "too_late" });
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    await expect(undoPendingSend()).resolves.toBe(false);
    expect(restoreComposer).not.toHaveBeenCalled();
    expect(notifications.toastError).toHaveBeenCalledWith({
      description: "Too late to undo. This email was already sent.",
    });
    await expect(undoPendingSend()).resolves.toBe(false);
  });

  it("lets the user retry undo when the server can't be reached", async () => {
    const restoreComposer = vi.fn();
    const { client, cancel } = activeClient({ cancelStatus: "unavailable" });
    server.cancelHeldSendAction.mockRejectedValue(new Error("offline"));
    beginUndoSend({
      client,
      operationId: "mutation",
      emailAccountId: "account",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    // Starting a send replaces whatever toast an earlier test left open.
    notifications.dismiss.mockClear();

    await expect(undoPendingSend()).resolves.toBe(false);
    expect(notifications.dismiss).not.toHaveBeenCalled();
    expect(restoreComposer).not.toHaveBeenCalled();

    cancel.mockResolvedValue({ status: "cancelled" });
    await expect(undoPendingSend()).resolves.toBe(true);
    expect(restoreComposer).toHaveBeenCalledOnce();
  });
});

function createClient(options?: {
  cancelStatus?: "cancelled" | "too_late" | "unavailable";
}) {
  const handle = createHandle();
  const cancel = vi
    .fn()
    .mockResolvedValue({ status: options?.cancelStatus ?? "cancelled" });
  const client = {
    cancelOperation: cancel,
    observeOperation: vi.fn(() => handle),
  } as unknown as MailClient;
  return { client, handle, cancel };
}

function activeClient(options?: Parameters<typeof createClient>[0]) {
  const created = createClient(options);
  setActiveMailClient(created.client);
  return created;
}

function createHandle() {
  let listener: (() => void) | undefined;
  let data: OperationState | null = operationState("queued");
  const handle: QueryHandle<OperationState> & {
    set: (status: OperationState["status"]) => void;
    subscribe: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  } = {
    getSnapshot: () => ({
      status: data ? "ready" : "loading",
      revision: null,
      data,
      refreshing: false,
      error: null,
    }),
    subscribe: vi.fn((next: () => void) => {
      listener = next;
      return vi.fn();
    }),
    close: vi.fn(),
    set(status) {
      data = operationState(status);
      listener?.();
    },
  };
  return handle;
}

function operationState(status: OperationState["status"]): OperationState {
  return {
    key: { accountId: "account", operationId: "mutation" },
    status,
    authority: "backend",
    attempts: 0,
    nextAttemptAtMs: null,
    error: null,
  };
}
