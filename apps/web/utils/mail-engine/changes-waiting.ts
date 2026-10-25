import type { MailWaitingSummary } from "@inboxzero/mail-core/engine";

/** Changes younger than this are still on their normal way to the provider. */
export const CHANGES_WAITING_AFTER_MS = 30_000;

export type WaitingAccountState = "waiting" | "retrying" | "reconnect";

export type WaitingAccount = {
  accountId: string;
  state: WaitingAccountState;
  count: number;
  /**
   * What the waiting changes do, most common first. Built only from a
   * change's kind and on/off flags: the summary carries no label, folder or
   * category names, and none may be added here, since this text is shown.
   */
  kinds: Array<{ label: string; count: number }>;
};

type WaitingGroup = MailWaitingSummary["groups"][number];

/**
 * The accounts whose changes have waited long enough to mention, or that
 * need reconnecting. Changes held for a connection count only while the
 * device is offline; once it's back the engine releases them.
 */
export function summarizeWaitingChanges(
  summaries: MailWaitingSummary[],
  { nowMs, online }: { nowMs: number; online: boolean },
): WaitingAccount[] {
  return summaries.flatMap((summary) => {
    const groups = summary.groups.filter(
      (group) => online === false || !group.heldOffline,
    );
    const count = groups.reduce((total, group) => total + group.count, 0);
    const blocked =
      summary.connection === "blocked_auth" ||
      groups.some((group) => group.status === "blocked_auth");
    const oldest = Math.min(...groups.map((group) => group.oldestWaitingAtMs));
    const overdue = count > 0 && nowMs - oldest >= CHANGES_WAITING_AFTER_MS;
    if (!blocked && !overdue) return [];
    return [
      {
        accountId: summary.accountId,
        state: accountState(blocked, groups),
        count,
        kinds: countKinds(groups),
      },
    ];
  });
}

/**
 * Whether any account has a change on its way, so the indicator may need to
 * show soon. A signed-out account with nothing waiting already shows its
 * reconnect state, and only reconnecting changes that.
 */
export function hasPendingChanges(summaries: MailWaitingSummary[]) {
  return summaries.some((summary) => summary.groups.length > 0);
}

/** Whether anything waiting could go now if the engine were asked. */
export function hasDeliverableChanges(accounts: WaitingAccount[]) {
  return accounts.some(
    (account) => account.state !== "reconnect" && account.count > 0,
  );
}

function accountState(
  blocked: boolean,
  groups: WaitingGroup[],
): WaitingAccountState {
  if (blocked) return "reconnect";
  if (
    groups.some(
      (group) => group.status === "retry_wait" || group.status === "uncertain",
    )
  ) {
    return "retrying";
  }
  return "waiting";
}

function countKinds(groups: WaitingGroup[]) {
  const counts = new Map<string, number>();
  for (const group of groups) {
    const label = changeKindLabel(group);
    counts.set(label, (counts.get(label) ?? 0) + group.count);
  }
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

function changeKindLabel(group: WaitingGroup) {
  if (group.kind === "send") return "Send";
  switch (group.changeKind) {
    case "archive":
      return "Archive";
    case "unarchive":
      return "Move to inbox";
    case "set_read":
      return group.on === false ? "Mark unread" : "Mark read";
    case "set_starred":
      return group.on === false ? "Unstar" : "Star";
    case "trash":
      return "Delete";
    case "restore_from_trash":
      return "Restore";
    case "set_spam":
      return group.on === false ? "Not spam" : "Report spam";
    case "move":
      return "Move";
    case "set_membership":
      if (group.membership === "category") {
        return group.on === false ? "Remove category" : "Categorize";
      }
      return group.on === false ? "Remove label" : "Label";
    case "snooze":
      return "Snooze";
    default:
      return "Other change";
  }
}
