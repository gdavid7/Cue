import type { ProviderChange } from "@inboxzero/mail-core/sync";

// Changes to older mail (reads, archives, moves) are not mail arriving, and
// not mail anyone is waiting on.
const NEW_MAIL_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * A synced change that is new mail now in the inbox: what server-side
 * reactions to new mail (the Gmail catch-up nudge, mute, snooze wake) look at
 * in what the client's mail sync read. Cue's own archive of a message syncs
 * without the inbox role, so it never counts.
 */
export function isRecentInboxArrival(
  change: ProviderChange,
  now = Date.now(),
): change is Extract<ProviderChange, { kind: "message_patch" }> {
  if (change.kind !== "message_patch") return false;
  if (!change.fields.roles?.includes("inbox")) return false;
  return (change.fields.receivedAtMs ?? 0) >= now - NEW_MAIL_WINDOW_MS;
}
