import { toast } from "sonner";
import {
  toastError,
  toastSendFailed,
  toastSending,
  toastSendUndone,
  toastSent,
} from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationStatus } from "@inboxzero/mail-core/operations";

export const UNDO_SEND_DELAY_MS = 10_000;
const UNDO_SEND_TOAST_ID = "undo-send";
// How long "Sending…" waits after the hold for the send to settle before the
// toast steps aside; the thread's delivery status carries on from there.
const SEND_SETTLE_TIMEOUT_MS = 60_000;
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
  const result = await current.client.cancelOperation({
    accountId: current.emailAccountId,
    operationId: current.operationId,
  });
  current.undoing = false;
  if (result.status === "unavailable") {
    // The send is still held, so the user can try again within the window.
    toastError({
      description: "Couldn't reach the server to undo. Try again.",
    });
    return false;
  }
  if (result.status === "cancelled") {
    if (tracked === current) stopTracking({ dismiss: false });
    current.restoreComposer();
    toastSendUndone(current.toastId);
    return true;
  }
  // Too late means the send is on its way, so the toast keeps reporting it.
  current.holding = false;
  if (result.status === "too_late") {
    if (tracked === current) toastSending({ id: current.toastId });
  } else if (tracked === current) {
    stopTracking({ dismiss: true });
  }
  toastError({
    description:
      result.status === "too_late"
        ? "Too late to undo. This email was already sent."
        : "Couldn't undo send",
  });
  return false;
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
