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
  toastSendUndoneElsewhere: vi.fn(),
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

const navigation = vi.hoisted(() => ({ redirectToSafeUrl: vi.fn() }));
vi.mock("@/utils/redirect", () => navigation);

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

  it("tells the running engine about an undo the server took", async () => {
    const restoreComposer = vi.fn();
    const engine = activeClient({ cancelStatus: "unavailable" });
    beginUndoSend({
      client: engine.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });

    await expect(undoPendingSend()).resolves.toBe(true);
    expect(server.cancelHeldSendAction).toHaveBeenCalledOnce();
    // Once to ask, once to record the server's cancellation.
    expect(engine.cancel).toHaveBeenCalledTimes(2);
  });

  it("does not ask to retry an undo the server refused", async () => {
    const restoreComposer = vi.fn();
    beginUndoSend({
      client: createClient().client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer,
    });
    server.cancelHeldSendAction.mockResolvedValue({
      serverError: "Unauthorized",
    });

    await expect(undoPendingSend()).resolves.toBe(false);
    expect(restoreComposer).not.toHaveBeenCalled();
    expect(notifications.toastError).toHaveBeenCalledWith({
      description: "Couldn't undo send",
    });
    await expect(undoPendingSend()).resolves.toBe(false);
    expect(server.cancelHeldSendAction).toHaveBeenCalledOnce();
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

// Switching account reloads the page, which drops everything in memory: the
// toast, the tracked send and the engine. The server and the local mailbox
// still hold the send, so the next page takes the undo back up.
describe("undo send across a page reload", () => {
  let storage: Map<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    server.cancelHeldSendAction.mockResolvedValue({
      data: { status: "cancelled" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("offers undo again on the page an account switch reloads to", async () => {
    const before = await loadPage();
    const original = createClient();
    before.setActiveMailClient(original.client);
    before.beginUndoSend({
      client: original.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
    });
    vi.clearAllMocks();

    const after = await loadPage();
    const stop = after.resumeUndoSend();
    // The next page's engine starts after the page does.
    expect(notifications.toastSending).not.toHaveBeenCalled();
    const next = createClient();
    after.setActiveMailClient(next.client);

    expect(notifications.toastSending).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "undo-send:mutation",
        hold: expect.objectContaining({ onUndo: expect.any(Function) }),
      }),
    );
    await expect(after.undoPendingSend()).resolves.toBe(true);
    expect(next.cancel).toHaveBeenCalledWith({
      accountId: "account-a",
      operationId: "mutation",
    });
    expect(notifications.toastSendUndoneElsewhere).toHaveBeenCalledWith({
      id: "undo-send:mutation",
      onEdit: expect.any(Function),
    });
    stop();
  });

  it("reopens an undone new message in the account it was written from", async () => {
    await holdOnFirstPage({ emailAccountId: "account-a" });
    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();
    await after.undoPendingSend();

    const [{ onEdit }] =
      notifications.toastSendUndoneElsewhere.mock.calls.at(-1) ?? [];
    onEdit();
    expect(navigation.redirectToSafeUrl).toHaveBeenCalledWith(
      "/account-a/mail",
    );

    // The page the redirect lands on opens the composer once its engine runs.
    const landed = await loadPage();
    const open = vi.fn();
    landed.reopenUndoneComposer("account-b", open)();
    const stop = landed.reopenUndoneComposer("account-a", open);
    expect(open).not.toHaveBeenCalled();
    landed.setActiveMailClient(createClient().client);
    expect(open).toHaveBeenCalledOnce();
    stop();
    landed.reopenUndoneComposer("account-a", open)();
    expect(open).toHaveBeenCalledOnce();
  });

  it("reopens an undone reply in its thread", async () => {
    await holdOnFirstPage({
      emailAccountId: "account-a",
      replyThreadId: "thread 1",
    });
    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();
    await after.undoPendingSend();

    const [{ onEdit }] =
      notifications.toastSendUndoneElsewhere.mock.calls.at(-1) ?? [];
    onEdit();
    expect(navigation.redirectToSafeUrl).toHaveBeenCalledWith(
      "/account-a/mail?thread-id=thread+1",
    );
    const open = vi.fn();
    after.reopenUndoneComposer("account-a", open)();
    expect(open).not.toHaveBeenCalled();
  });

  it("cancels on the server when the next page's engine has no record of the send", async () => {
    await holdOnFirstPage();
    const after = await loadPage();
    const next = createClient({ cancelStatus: "not_found" });
    after.setActiveMailClient(next.client);
    after.resumeUndoSend()();

    await expect(after.undoPendingSend()).resolves.toBe(true);
    expect(server.cancelHeldSendAction).toHaveBeenCalledWith("account-a", {
      operationId: "mutation",
    });
  });

  it("offers no draft to edit when only the server could undo", async () => {
    await holdOnFirstPage();
    const after = await loadPage();
    // A store that never had this mailbox, as in a memory-only engine.
    const next = createClient({
      cancelStatus: "not_found",
      draft: "not_found",
    });
    after.setActiveMailClient(next.client);
    after.resumeUndoSend()();

    await expect(after.undoPendingSend()).resolves.toBe(true);
    expect(server.cancelHeldSendAction).toHaveBeenCalledOnce();
    expect(next.readDraft).toHaveBeenCalledWith({
      accountId: "account-a",
      draftId: "mutation",
    });
    expect(notifications.toastSendUndoneElsewhere).toHaveBeenCalledWith({
      id: "undo-send:mutation",
    });
  });

  it("does not offer undo after a reload once undo was too late", async () => {
    const before = await holdOnFirstPage();
    before.client.cancel.mockResolvedValue({ status: "too_late" });
    await expect(before.page.undoPendingSend()).resolves.toBe(false);
    expect(storage.has("cue:undo-send")).toBe(false);

    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();
    expect(notifications.toastSending).not.toHaveBeenCalledWith(
      expect.objectContaining({ hold: expect.anything() }),
    );
  });

  it("forgets the held send once its hold ends on the page", async () => {
    vi.useFakeTimers();
    await holdOnFirstPage();
    expect(storage.has("cue:undo-send")).toBe(true);
    vi.advanceTimersByTime(UNDO_SEND_DELAY_MS);
    expect(storage.has("cue:undo-send")).toBe(false);
  });

  it("forgets the held send and a pending reopen on sign out", async () => {
    await holdOnFirstPage();
    const after = await loadPage();
    storage.set(
      "cue:undo-send-reopen",
      JSON.stringify({ emailAccountId: "account-a", at: Date.now() }),
    );
    const stop = after.resumeUndoSend();
    await after.closeActiveMailEngine();

    expect(storage.has("cue:undo-send")).toBe(false);
    expect(storage.has("cue:undo-send-reopen")).toBe(false);
    stop();
  });

  it("drops a reopen request for another account or one left too long", async () => {
    const page = await loadPage();
    page.setActiveMailClient(createClient().client);
    const open = vi.fn();
    storage.set(
      "cue:undo-send-reopen",
      JSON.stringify({ emailAccountId: "account-a", at: Date.now() }),
    );
    page.reopenUndoneComposer("account-b", open)();
    expect(storage.has("cue:undo-send-reopen")).toBe(false);
    page.reopenUndoneComposer("account-a", open)();

    storage.set(
      "cue:undo-send-reopen",
      JSON.stringify({ emailAccountId: "account-a", at: Date.now() - 120_000 }),
    );
    page.reopenUndoneComposer("account-a", open)();
    expect(open).not.toHaveBeenCalled();
    expect(storage.has("cue:undo-send-reopen")).toBe(false);
  });

  it("stores only the send's ids", async () => {
    const page = await loadPage();
    const client = createClient();
    page.setActiveMailClient(client.client);
    page.beginUndoSend({
      client: client.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
      subject: "Not for storage",
    } as Parameters<typeof page.beginUndoSend>[0]);

    expect(
      Object.keys(JSON.parse(storage.get("cue:undo-send") ?? "{}")).sort(),
    ).toEqual(["emailAccountId", "holdUntil", "operationId"]);
  });

  it("confirms an undo without waiting on a draft lookup the engine is slow to answer", async () => {
    vi.useFakeTimers();
    await holdOnFirstPage();
    const after = await loadPage();
    const next = createClient();
    // An engine busy syncing after the reload answers reads late.
    next.readDraft.mockReturnValue(new Promise(() => {}));
    after.setActiveMailClient(next.client);
    after.resumeUndoSend()();

    const undone = after.undoPendingSend();
    await vi.advanceTimersByTimeAsync(5000);

    await expect(undone).resolves.toBe(true);
    expect(notifications.toastSendUndoneElsewhere).toHaveBeenCalledWith({
      id: "undo-send:mutation",
    });
  });

  it("tells the user an undo that landed as the page left went through", async () => {
    await holdOnFirstPage();
    const after = await loadPage();
    const next = createClient();
    next.handle.set("cancelled");
    after.setActiveMailClient(next.client);
    after.resumeUndoSend()();

    await vi.waitFor(() =>
      expect(notifications.toastSendUndoneElsewhere).toHaveBeenCalledWith({
        id: "undo-send:mutation",
        onEdit: expect.any(Function),
      }),
    );
    await expect(after.undoPendingSend()).resolves.toBe(false);
  });

  it("offers undo again when an undo pressed as the page left never landed", async () => {
    const before = await holdOnFirstPage();
    // The page unloads before the engine answers.
    before.client.cancel.mockReturnValue(new Promise(() => {}));
    before.page.undoPendingSend().catch(() => {});

    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();

    await expect(after.undoPendingSend()).resolves.toBe(true);
  });

  it("reports a send that went out while the page was switching", async () => {
    await holdOnFirstPage();
    const after = await loadPage();
    const next = createClient();
    next.handle.set("succeeded");
    after.setActiveMailClient(next.client);
    after.resumeUndoSend()();

    expect(notifications.toastSent).toHaveBeenCalledWith("undo-send:mutation");
    await expect(after.undoPendingSend()).resolves.toBe(false);
  });

  it("does not offer undo once the hold ended before the next page started", async () => {
    vi.useFakeTimers();
    await holdOnFirstPage();
    vi.advanceTimersByTime(UNDO_SEND_DELAY_MS);
    // The page left before its own hold ended, so nothing settled there.
    vi.clearAllMocks();
    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();

    expect(notifications.toastSending).not.toHaveBeenCalled();
    const later = await loadPage();
    later.setActiveMailClient(createClient().client);
    later.resumeUndoSend()();
    expect(notifications.toastSending).not.toHaveBeenCalled();
  });

  it("does not offer undo again for a send that had settled when undo began", async () => {
    const page = await loadPage();
    const client = createClient();
    client.handle.set("succeeded");
    page.setActiveMailClient(client.client);
    page.beginUndoSend({
      client: client.client,
      operationId: "mutation",
      emailAccountId: "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
    });
    vi.clearAllMocks();

    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();
    expect(notifications.toastSending).not.toHaveBeenCalled();
  });

  it("does not offer undo again after the send settled", async () => {
    const before = await holdOnFirstPage();
    before.client.handle.set("succeeded");

    const after = await loadPage();
    after.setActiveMailClient(createClient().client);
    after.resumeUndoSend()();
    expect(notifications.toastSending).not.toHaveBeenCalled();
  });

  async function holdOnFirstPage(
    options: { emailAccountId?: string; replyThreadId?: string } = {},
  ) {
    const page = await loadPage();
    const client = createClient();
    page.setActiveMailClient(client.client);
    page.beginUndoSend({
      client: client.client,
      operationId: "mutation",
      emailAccountId: options.emailAccountId ?? "account-a",
      holdUntil: Date.now() + UNDO_SEND_DELAY_MS,
      restoreComposer: vi.fn(),
      replyThreadId: options.replyThreadId,
    });
    vi.clearAllMocks();
    server.cancelHeldSendAction.mockResolvedValue({
      data: { status: "cancelled" },
    });
    return { page, client };
  }
});

function createClient(options?: {
  cancelStatus?: "cancelled" | "too_late" | "unavailable" | "not_found";
  /** Whether this device's store still has the send's draft. */
  draft?: "found" | "not_found";
}) {
  const handle = createHandle();
  const cancel = vi
    .fn()
    .mockResolvedValue({ status: options?.cancelStatus ?? "cancelled" });
  const readDraft = vi
    .fn()
    .mockResolvedValue({ status: options?.draft ?? "found" });
  const client = {
    cancelOperation: cancel,
    observeOperation: vi.fn(() => handle),
    readDraft,
  } as unknown as MailClient;
  return { client, handle, cancel, readDraft };
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

// A fresh copy of the page's modules, as a reload leaves them; session
// storage is what carries over.
async function loadPage() {
  vi.resetModules();
  const undo = await import("./undo-send");
  const active = await import("@/utils/mail-engine/active-client");
  return {
    ...undo,
    setActiveMailClient: active.setActiveMailClient,
    closeActiveMailEngine: active.closeActiveMailEngine,
  };
}
