import type { MailDiagnostics } from "@inboxzero/mail-core/engine";
import type { OperationStatus } from "@inboxzero/mail-core/operations";

/** Changes younger than this are still on their normal way to the provider. */
export const CHANGES_WAITING_AFTER_MS = 30_000;

export type WaitingAccountState = "waiting" | "retrying" | "reconnect";

export type WaitingAccount = {
  accountId: string;
  state: WaitingAccountState;
  count: number;
  /** What the waiting changes do, most common first; never their content. */
  kinds: Array<{ label: string; count: number }>;
};

// Changes the engine still means to deliver. A partly applied change
// (needs_attention) is not on its way anywhere, so it isn't counted.
const WAITING_STATUSES = new Set<OperationStatus>([
  "preparing",
  "queued",
  "executing",
  "verifying",
  "retry_wait",
  "uncertain",
  "blocked_auth",
]);

/**
 * The accounts whose changes have waited long enough to mention, or that
 * need reconnecting, from each account's engine diagnostics.
 */
export function summarizeWaitingChanges(
  diagnostics: MailDiagnostics[],
  nowMs: number,
): WaitingAccount[] {
  return diagnostics.flatMap((account) => {
    const waiting = account.commands.filter((command) =>
      WAITING_STATUSES.has(command.status),
    );
    const blocked =
      account.connection === "blocked_auth" ||
      waiting.some((command) => command.status === "blocked_auth");
    const overdue =
      waiting.length > 0 &&
      account.oldestPendingAtMs !== null &&
      nowMs - account.oldestPendingAtMs >= CHANGES_WAITING_AFTER_MS;
    if (!blocked && !overdue) return [];
    return [
      {
        accountId: account.accountId,
        state: accountState(blocked, waiting),
        count: waiting.length,
        kinds: countKinds(waiting),
      },
    ];
  });
}

/**
 * Whether any account has a change still on its way or is signed out, so the
 * indicator may need to show soon.
 */
export function hasPendingChanges(diagnostics: MailDiagnostics[]) {
  return diagnostics.some(
    (account) =>
      account.connection === "blocked_auth" ||
      account.commands.some((command) => WAITING_STATUSES.has(command.status)),
  );
}

/** Whether anything waiting could go now if the engine were asked. */
export function hasDeliverableChanges(accounts: WaitingAccount[]) {
  return accounts.some(
    (account) => account.state !== "reconnect" && account.count > 0,
  );
}

function accountState(
  blocked: boolean,
  waiting: MailDiagnostics["commands"],
): WaitingAccountState {
  if (blocked) return "reconnect";
  if (
    waiting.some(
      (command) =>
        command.status === "retry_wait" || command.status === "uncertain",
    )
  ) {
    return "retrying";
  }
  return "waiting";
}

function countKinds(commands: MailDiagnostics["commands"]) {
  const counts = new Map<string, number>();
  for (const command of commands) {
    const label = changeKindLabel(command);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function changeKindLabel(command: MailDiagnostics["commands"][number]) {
  if (command.kind === "send") return "Send";
  const change = command.change ?? {};
  switch (command.changeKind) {
    case "archive":
      return "Archive";
    case "unarchive":
      return "Move to inbox";
    case "set_read":
      return change.read === false ? "Mark unread" : "Mark read";
    case "set_starred":
      return change.starred === false ? "Unstar" : "Star";
    case "trash":
      return "Delete";
    case "restore_from_trash":
      return "Restore";
    case "set_spam":
      return change.spam === false ? "Not spam" : "Report spam";
    case "move":
      return "Move";
    case "set_membership":
      if (change.membership === "category") {
        return change.present === false ? "Remove category" : "Categorize";
      }
      return change.present === false ? "Remove label" : "Label";
    case "snooze":
      return "Snooze";
    default:
      return "Other change";
  }
}
