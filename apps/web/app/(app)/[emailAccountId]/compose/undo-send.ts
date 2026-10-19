import { toast } from "sonner";
import {
  toastError,
  toastSendFailed,
  toastSending,
  toastSendUndone,
  toastSent,
} from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import { cancelHeldSendAction } from "@/utils/actions/scheduled-email";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationStatus } from "@inboxzero/mail-core/operations";

export const UNDO_SEND_DELAY_MS = 10_000;
const UNDO_SEND_TOAST_ID = "undo-send";
// How long "Sending…" waits after the hold for the send to settle before the
// toast steps aside; the thread's delivery status carries on from there.
const SEND_SETTLE_TIMEOUT_MS = 60_000;
// A closed worker never answers, so undo stops waiting on the engine well
// inside the hold and asks the server directly.
const ENGINE_CANCEL_TIMEOUT_MS = 3000;
// The server holds the send while it is executing or verifying, so undo stays
// open until the send leaves it or the window ends.
const UNDOABLE_STATUSES = new Set<OperationStatus>([
  "preparing",
  "queued",
  "executing",
  "verifying",
  "retry_wait",
]);

/** One send's toast, from the hold until the send settles. */
type TrackedSend = {
  client: MailClient;
  operationId: string;
  emailAccountId: string;
  restoreComposer: () => void;
  toastId: string;
  /** Undo is offered only while the send is held. */
  holding: boolean;
  undoing: boolean;
  release: () => void;
};

let tracked: TrackedSend | null = null;

export function getUndoSendHoldUntil(online: boolean, now = Date.now()) {
  return online ? now + UNDO_SEND_DELAY_MS : undefined;
}

export function beginUndoSend({
  client,
  operationId,
  emailAccountId,
  restoreComposer,
  holdUntil,
}: {
  client: MailClient;
  operationId: string;
  emailAccountId: string;
  restoreComposer: () => void;
  holdUntil: number;
}) {
  const duration = holdUntil - Date.now();
  if (duration <= 0) return;
  stopTracking({ dismiss: true });
  const handle = client.observeOperation({
    accountId: emailAccountId,
    operationId,
  });
  let unsubscribe = () => {};
  const toastId = undoSendToastId(operationId);
  const current: TrackedSend = {
    client,
    operationId,
    emailAccountId,
    restoreComposer,
    toastId,
    holding: true,
    undoing: false,
    release: () => {
      clearTimeout(holdTimeout);
      clearTimeout(settleTimeout);
      unsubscribe();
      handle.close();
    },
  };
  const settle = (show: () => void) => {
    if (tracked !== current) return;
    stopTracking({ dismiss: false });
    show();
  };
  const holdTimeout = setTimeout(() => {
    if (tracked !== current || current.undoing) return;
    current.holding = false;
    toastSending({ id: toastId });
  }, duration);
  const settleTimeout = setTimeout(
    () => settle(() => toast.dismiss(toastId)),
    duration + SEND_SETTLE_TIMEOUT_MS,
  );
  tracked = current;
  const inspect = () => {
    if (tracked !== current || current.undoing) return;
    const status = handle.getSnapshot().data?.status;
    if (!status || UNDOABLE_STATUSES.has(status)) return;
    if (status === "succeeded") settle(() => toastSent(toastId));
    else if (status === "failed" || status === "needs_attention")
      settle(() => toastSendFailed({ id: toastId, onRetry: restoreComposer }));
    // Cancelled, uncertain and blocked sends are reported by the composer.
    else settle(() => toast.dismiss(toastId));
  };
  unsubscribe = handle.subscribe(inspect);
  toastSending({
    id: toastId,
    hold: {
      durationMs: duration,
      shortcut: getShortcutHint("undo"),
      // A replaced toast can still fire during its exit animation, after a
      // newer send has taken over.
      onUndo: async () => {
        if (tracked === current) await undoPendingSend();
      },
    },
  });
  inspect();
}

export async function undoPendingSend() {
  const current = tracked;
  if (!current?.holding || current.undoing) return false;
  current.undoing = true;
  const status = await cancelSend(current);
  current.undoing = false;
  if (status === "unavailable") {
    // The send is still held, so the user can try again within the window.
    toastError({
      description: "Couldn't reach the server to undo. Try again.",
    });
    return false;
  }
  if (status === "cancelled") {
    if (tracked === current) stopTracking({ dismiss: false });
    current.restoreComposer();
    toastSendUndone(current.toastId);
    return true;
  }
  // Too late means the send is on its way, so the toast keeps reporting it.
  current.holding = false;
  if (status === "too_late") {
    if (tracked === current) toastSending({ id: current.toastId });
  } else if (tracked === current) {
    stopTracking({ dismiss: true });
  }
  toastError({
    description:
      status === "too_late"
        ? "Too late to undo. This email was already sent."
        : "Couldn't undo send",
  });
  return false;
}

/**
 * The engine cancels a send it has not dispatched yet, so it is asked first
 * while it is still the one the send was queued on. Once an account switch has
 * replaced or closed that engine, or it stops answering, the server's hold is
 * cancelled directly; the server also refuses the send if it arrives later.
 */
async function cancelSend(current: TrackedSend) {
  const key = {
    accountId: current.emailAccountId,
    operationId: current.operationId,
  };
  const active = getActiveMailClient();
  if (active === current.client) {
    const local = await withTimeout(
      active.cancelOperation(key),
      ENGINE_CANCEL_TIMEOUT_MS,
    ).catch(() => null);
    if (local && local.status !== "unavailable") return local.status;
  }
  const status = await cancelOnServer(current);
  if (status === "cancelled" && active && active !== current.client) {
    // The engine now running owns the queued copy; without this it would
    // dispatch it and record the server's refusal as a failed send.
    active.cancelOperation(key).catch(() => undefined);
  }
  return status;
}

async function cancelOnServer(current: TrackedSend) {
  try {
    const result = await cancelHeldSendAction(current.emailAccountId, {
      operationId: current.operationId,
    });
    return result?.data?.status ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

function stopTracking({ dismiss }: { dismiss: boolean }) {
  const previous = tracked;
  if (!previous) return;
  tracked = null;
  previous.release();
  if (dismiss) toast.dismiss(previous.toastId);
}

function undoSendToastId(operationId: string) {
  return `${UNDO_SEND_TOAST_ID}:${operationId}`;
}
