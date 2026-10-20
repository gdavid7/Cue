import { toast } from "sonner";
import { z } from "zod";
import {
  toastError,
  toastSendFailed,
  toastSending,
  toastSendUndone,
  toastSendUndoneElsewhere,
  toastSent,
} from "@/components/Toast";
import { getShortcutHint } from "@/lib/shortcuts/registry";
import { cancelHeldSendAction } from "@/utils/actions/scheduled-email";
import {
  getActiveMailClient,
  observeOperationOnActiveEngine,
  subscribeActiveMailClient,
} from "@/utils/mail-engine/active-client";
import { redirectToSafeUrl } from "@/utils/redirect";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationStatus } from "@inboxzero/mail-core/operations";

export const UNDO_SEND_DELAY_MS = 10_000;
const UNDO_SEND_TOAST_ID = "undo-send";
// Switching account reloads the page, so the held send's ids are kept for the
// next page in this tab to take the undo back up. Ids only, never content.
const HELD_SEND_STORAGE_KEY = "cue:undo-send";
const REOPEN_COMPOSER_STORAGE_KEY = "cue:undo-send-reopen";
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

const heldSendSchema = z.object({
  operationId: z.string().min(1),
  emailAccountId: z.string().min(1),
  holdUntil: z.number(),
  /** The thread a reply was written in; absent for a new message. */
  replyThreadId: z.string().min(1).optional(),
});
type HeldSend = z.infer<typeof heldSendSchema>;

/** One send's toast, from the hold until the send settles. */
type TrackedSend = {
  /** The engine the send is watched on, which follows a replaced engine. */
  watch: { readonly client: MailClient };
  operationId: string;
  emailAccountId: string;
  restoreComposer: () => void;
  /**
   * Set when the send was written on an earlier page, whose composer is gone:
   * the draft is opened again where it was written instead.
   */
  reopenDraft?: () => void;
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
  restoreComposer,
  ...held
}: HeldSend & {
  client: MailClient;
  restoreComposer: () => void;
}) {
  if (held.holdUntil <= Date.now()) return;
  trackSend({ client, held, restoreComposer });
}

/**
 * Takes up the undo of a send held on the page before this one in the tab,
 * once this page's engine is running. Returns a function that stops waiting.
 */
export function resumeUndoSend() {
  return whenMailEngineRuns((client) => {
    const held = readHeldSend();
    if (!held || tracked) return;
    if (held.holdUntil <= Date.now()) {
      removeSession(HELD_SEND_STORAGE_KEY);
      return;
    }
    trackSend({
      client,
      held,
      restoreComposer: () => {},
      reopenDraft: () => reopenDraft(held),
    });
  });
}

/**
 * Opens the composer when an undone send asked for this account's new
 * message to reopen, once the engine that holds its draft is running.
 * Returns a function that stops waiting.
 */
export function reopenUndoneComposer(
  emailAccountId: string,
  openComposer: () => void,
) {
  return whenMailEngineRuns(() => {
    if (readSession(REOPEN_COMPOSER_STORAGE_KEY) !== emailAccountId) return;
    removeSession(REOPEN_COMPOSER_STORAGE_KEY);
    openComposer();
  });
}

function trackSend({
  client,
  held,
  restoreComposer,
  reopenDraft,
}: {
  client: MailClient;
  held: HeldSend;
  restoreComposer: () => void;
  reopenDraft?: () => void;
}) {
  const { operationId, emailAccountId, holdUntil } = held;
  const duration = holdUntil - Date.now();
  stopTracking({ dismiss: true });
  // Before the first look at the send, which may already have settled it.
  writeSession(HELD_SEND_STORAGE_KEY, JSON.stringify(held));
  const handle = observeOperationOnActiveEngine(client, {
    accountId: emailAccountId,
    operationId,
  });
  let unsubscribe = () => {};
  const toastId = undoSendToastId(operationId);
  const current: TrackedSend = {
    watch: handle,
    operationId,
    emailAccountId,
    restoreComposer,
    reopenDraft,
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
      settle(() =>
        toastSendFailed({
          id: toastId,
          onRetry: reopenDraft ?? restoreComposer,
        }),
      );
    // An undo that landed as the page before this one left.
    else if (status === "cancelled" && reopenDraft)
      settle(() =>
        toastSendUndoneElsewhere({ id: toastId, onEdit: reopenDraft }),
      );
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
    if (current.reopenDraft) {
      toastSendUndoneElsewhere({
        id: current.toastId,
        onEdit: current.reopenDraft,
      });
    } else {
      current.restoreComposer();
      toastSendUndone(current.toastId);
    }
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
 * while it is running: the one the send was queued on, or the one that
 * replaced it on the same mailbox. Once no engine is running, or it stops
 * answering, the server's hold is cancelled directly; the server also refuses
 * the send if it arrives later.
 */
async function cancelSend(current: TrackedSend) {
  const key = {
    accountId: current.emailAccountId,
    operationId: current.operationId,
  };
  const active = getActiveMailClient();
  if (active && active === current.watch.client) {
    const local = await withTimeout(
      active.cancelOperation(key),
      ENGINE_CANCEL_TIMEOUT_MS,
    ).catch(() => null);
    // An engine with no record of the send (a page that never opened this
    // mailbox) leaves it to the server, which holds it either way.
    if (local && local.status !== "unavailable" && local.status !== "not_found")
      return local.status;
  }
  const status = await cancelOnServer(current);
  if (status === "cancelled" && active && active !== current.watch.client) {
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
  removeSession(HELD_SEND_STORAGE_KEY);
  if (dismiss) toast.dismiss(previous.toastId);
}

function whenMailEngineRuns(run: (client: MailClient) => void) {
  let stop = () => {};
  const check = () => {
    const client = getActiveMailClient();
    if (!client) return;
    stop();
    run(client);
  };
  stop = subscribeActiveMailClient(check);
  check();
  return () => stop();
}

function reopenDraft(held: HeldSend) {
  if (held.replyThreadId) {
    // The thread opens its saved reply drafts by itself.
    const query = new URLSearchParams({ "thread-id": held.replyThreadId });
    redirectToSafeUrl(`/${held.emailAccountId}/mail?${query}`);
    return;
  }
  writeSession(REOPEN_COMPOSER_STORAGE_KEY, held.emailAccountId);
  redirectToSafeUrl(`/${held.emailAccountId}/mail`);
}

function readHeldSend() {
  const raw = readSession(HELD_SEND_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = heldSendSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {}
  removeSession(HELD_SEND_STORAGE_KEY);
  return null;
}

function readSession(key: string) {
  try {
    return globalThis.sessionStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string) {
  try {
    globalThis.sessionStorage?.setItem(key, value);
  } catch {
    // Undo still works on this page; it just won't outlive a reload.
  }
}

function removeSession(key: string) {
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {}
}

function undoSendToastId(operationId: string) {
  return `${UNDO_SEND_TOAST_ID}:${operationId}`;
}
