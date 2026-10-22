"use client";

import { useEffect } from "react";
import { followMatchingJobs } from "@/app/(app)/[emailAccountId]/mail/use-select-all-matching";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { MatchingBulkAction } from "@/utils/actions/mail-bulk-matching.validation";
import { getActiveMailClient } from "@/utils/mail-engine/active-client";

// A job is followed by the tab that saw it start, once, however often the
// card renders or remounts.
const followedJobIds = new Set<string>();

export function CountEmailsResult({ output }: { output: unknown }) {
  const value = asRecord(output);
  const total = typeof value?.total === "number" ? value.total : null;
  if (total === null) return null;
  const exact = value?.exact !== false;
  return (
    <div className="text-xs text-muted-foreground">
      {exact ? "Counted" : "Counted at least"} {formatCount(total)}{" "}
      {total === 1 ? "email" : "emails"}
    </div>
  );
}

/**
 * manageInbox over everything a search matches: the count it is waiting on
 * the user to confirm, or the job it started, whose progress, stop and undo
 * follow the inbox's own select-all toast.
 */
export function ManageInboxQueryResult({
  input,
  output,
  isPersistedMessage,
}: {
  input: unknown;
  output: unknown;
  isPersistedMessage: boolean;
}) {
  const { emailAccountId } = useAccount();
  const value = asRecord(output);
  const status = value?.status;
  const jobId = typeof value?.jobId === "string" ? value.jobId : null;
  const action = getMatchingBulkActionForChat(input);
  const conversations =
    typeof value?.conversations === "number" ? value.conversations : null;

  useEffect(() => {
    // A reloaded chat shows the job it started without following it again.
    if (status !== "started" || !jobId || !action || isPersistedMessage) return;
    if (followedJobIds.has(jobId)) return;
    followedJobIds.add(jobId);
    followMatchingJobs({
      jobs: [{ accountId: emailAccountId, jobId }],
      action,
      // The mail list follows the local store, which this brings up to date.
      onFinished: () => {
        getActiveMailClient()
          ?.requestSync([emailAccountId])
          .catch(() => undefined);
      },
    }).catch(() => undefined);
  }, [status, jobId, action, isPersistedMessage, emailAccountId]);

  let text: string;
  if (status === "needs_confirmation") {
    text = `${conversations === null ? "Some" : formatCount(conversations)}${value?.atLeast ? "+" : ""} ${conversations === 1 ? "conversation matches" : "conversations match"}. Nothing has changed yet.`;
  } else if (status === "nothing_to_change") {
    text = "Nothing matched, so nothing changed.";
  } else {
    text =
      conversations === null
        ? "Started on every matching conversation."
        : `Started on ${formatCount(conversations)} ${conversations === 1 ? "conversation" : "conversations"}.`;
  }
  return <div className="text-xs text-muted-foreground">{text}</div>;
}

/** The select-all job a manageInbox call with a search runs as. */
export function getMatchingBulkActionForChat(
  input: unknown,
): MatchingBulkAction | null {
  const value = asRecord(input);
  switch (value?.action) {
    case "archive_threads":
      return "archive";
    case "mark_read_threads":
      return value.read === false ? "mark_unread" : "mark_read";
    case "label_threads":
    case "categorize_threads":
      return "label";
    default:
      return null;
  }
}

export function isManageInboxQueryOutput(output: unknown) {
  const status = asRecord(output)?.status;
  return (
    status === "needs_confirmation" ||
    status === "nothing_to_change" ||
    status === "started"
  );
}

function asRecord(value: unknown) {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function formatCount(count: number) {
  return count.toLocaleString("en-US");
}
