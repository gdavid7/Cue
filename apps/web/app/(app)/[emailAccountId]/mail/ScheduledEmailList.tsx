"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { AlertCircleIcon, ClockIcon, LoaderCircleIcon } from "lucide-react";
import type { UpcomingScheduledEmailsResponse } from "@/app/api/user/scheduled-emails/route";
import { AllInboxesFailedNotice } from "@/app/(app)/[emailAccountId]/mail/AllInboxesFailedNotice";
import { AccountRowMarker } from "@/app/(app)/[emailAccountId]/mail/all-accounts-list";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { InlineActionButton } from "@/components/InlineActionButton";
import { LoadingContent } from "@/components/LoadingContent";
import {
  cancelScheduledEmailAction,
  retryScheduledEmailAction,
} from "@/utils/actions/scheduled-email";
import { getActionErrorMessage } from "@/utils/error";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useMailHref } from "@/hooks/useMailHref";
import {
  refreshUpcomingScheduledEmails,
  useAllAccountsUpcomingScheduledEmails,
  useUpcomingScheduledEmails,
} from "@/hooks/useHiddenDraftMessageIds";

type ScheduledEmail =
  UpcomingScheduledEmailsResponse["scheduledEmails"][number];
type ScheduledRow = ScheduledEmail & { accountId: string };

/**
 * Sends waiting to go out. In All inboxes it lists every account's, soonest
 * first, each naming its account and acting in it.
 */
export function ScheduledEmailList({
  accounts,
}: {
  /** All inboxes: the accounts to list scheduled sends from. */
  accounts?: AllInboxesAccount[];
} = {}) {
  const { emailAccountId } = useAccount();
  const mailHref = useMailHref();
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const { mutate: mutateCache } = useSWRConfig();
  const one = useUpcomingScheduledEmails(accounts ? null : emailAccountId);
  const all = useAllAccountsUpcomingScheduledEmails(accounts);
  const { isLoading, error, mutate } = accounts ? all : one;

  const runScheduledAction = async (
    action: typeof cancelScheduledEmailAction,
    row: ScheduledRow,
  ) => {
    // The send's own account, which the action checks is the user's.
    const result = await action(row.accountId, { id: row.id });
    if (result?.serverError || result?.validationErrors)
      throw new Error(getActionErrorMessage(result));
  };

  const act = async (action: () => Promise<unknown>, row: ScheduledRow) => {
    setBusy(true);
    setActionError("");
    try {
      await action();
      // The action already succeeded; a refresh that fails is stale data, not a
      // failed cancel, and SWR retries on its own.
      await Promise.all([
        mutate().catch(() => {}),
        // The cached reads elsewhere, such as All inboxes' Drafts, hide drafts
        // by these sends.
        refreshUpcomingScheduledEmails(mutateCache, row.accountId),
      ]);
    } catch (failure) {
      setActionError(
        failure instanceof Error ? failure.message : "Something went wrong",
      );
    } finally {
      setBusy(false);
    }
  };

  const rows: ScheduledRow[] = accounts
    ? (all.data?.byAccount ?? [])
        .flatMap(({ accountId, data }) =>
          data.scheduledEmails.map((row) => ({ ...row, accountId })),
        )
        .sort(
          (a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime(),
        )
    : (one.data?.scheduledEmails ?? []).map((row) => ({
        ...row,
        accountId: emailAccountId,
      }));

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {accounts ? (
        <AllInboxesFailedNotice
          accounts={accounts}
          failedAccountIds={all.data?.failedAccountIds ?? []}
          onRetry={() => mutate()}
        />
      ) : null}
      {actionError && (
        <p role="alert" className="px-4 py-2 text-destructive text-xs">
          {actionError}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <LoadingContent loading={isLoading} error={error}>
          {rows.length === 0 ? (
            <div className="px-6 py-12 text-center text-muted-foreground text-sm">
              Nothing scheduled. Emails you send later show up here until
              they&apos;re on their way.
            </div>
          ) : (
            <ul aria-label="Scheduled emails">
              {rows.map((row) => (
                <li
                  key={`${row.accountId}:${row.id}`}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-b px-4 py-3"
                >
                  <AccountRowMarker
                    accountId={row.accountId}
                    accounts={accounts}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground text-sm">
                      {row.subject?.trim() || "(no subject)"}
                    </p>
                    <p className="truncate text-muted-foreground text-xs">
                      {row.to?.trim() || "No recipient"}
                    </p>
                  </div>
                  <p
                    role="status"
                    className="flex shrink-0 items-center gap-2 text-muted-foreground text-xs"
                  >
                    <StatusIcon status={row.status} />
                    {statusLabel(row)}
                  </p>
                  <div className="flex shrink-0 gap-2">
                    {["PENDING", "BLOCKED_AUTH", "FAILED"].includes(
                      row.status,
                    ) && (
                      <InlineActionButton
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              runScheduledAction(
                                cancelScheduledEmailAction,
                                row,
                              ),
                            row,
                          )
                        }
                      >
                        Cancel send
                      </InlineActionButton>
                    )}
                    {row.status === "UNCERTAIN" && (
                      // Neither cancel nor retry accepts an uncertain row, so
                      // this is the only way to resolve one.
                      <a
                        className="text-xs underline underline-offset-4"
                        href={mailHref({
                          accountId: row.accountId,
                          view: { kind: "type", type: "sent" },
                        })}
                      >
                        Check Sent
                      </a>
                    )}
                    {["BLOCKED_AUTH", "FAILED"].includes(row.status) && (
                      <InlineActionButton
                        disabled={busy}
                        onClick={() =>
                          act(
                            () =>
                              runScheduledAction(
                                retryScheduledEmailAction,
                                row,
                              ),
                            row,
                          )
                        }
                      >
                        Retry send
                      </InlineActionButton>
                    )}
                  </div>
                  {row.error && (
                    <p className="basis-full text-destructive text-xs">
                      {row.error}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </LoadingContent>
      </div>
    </div>
  );
}

function StatusIcon({ status }: { status: ScheduledEmail["status"] }) {
  if (status === "PROCESSING")
    return <LoaderCircleIcon className="size-3.5 animate-spin" />;
  if (status === "PENDING") return <ClockIcon className="size-3.5" />;
  return <AlertCircleIcon className="size-3.5 text-destructive" />;
}

function statusLabel(row: ScheduledEmail) {
  switch (row.status) {
    case "PENDING":
      return formatTime(row.sendAt);
    case "PROCESSING":
      return "Sending…";
    case "UNCERTAIN":
      return "Couldn't confirm delivery";
    case "BLOCKED_AUTH":
      return "Reconnect your account to send this";
    default:
      return "Needs attention";
  }
}

function formatTime(value: string | Date) {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
