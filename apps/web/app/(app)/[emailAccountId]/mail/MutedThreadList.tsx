"use client";

import { useAction } from "next-safe-action/hooks";
import useSWR from "swr";
import { BellOffIcon } from "lucide-react";
import { toast } from "sonner";
import type { MutedThreadsResponse } from "@/app/api/user/muted-threads/route";
import { AllInboxesFailedNotice } from "@/app/(app)/[emailAccountId]/mail/AllInboxesFailedNotice";
import { AccountRowMarker } from "@/app/(app)/[emailAccountId]/mail/all-accounts-list";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useAllAccountsList } from "@/hooks/useAllAccountsList";
import { InlineActionButton } from "@/components/InlineActionButton";
import { LoadingContent } from "@/components/LoadingContent";
import { useAccount } from "@/providers/EmailAccountProvider";
import { unmuteThreadsAction } from "@/utils/actions/mute";
import { extractNameFromEmail } from "@/utils/email";
import { getActionErrorMessage } from "@/utils/error";
import { decodeSnippet } from "@/utils/gmail/decode";
import { getAccountScopedKey } from "@/utils/swr";
import { forgetMutedThreadIds } from "@/utils/web-notifications/muted-thread-ids";

const MUTED_PATH = "/api/user/muted-threads";

type MutedRow = MutedThreadsResponse["threads"][number] & {
  accountId: string;
};

/**
 * Mutes live in our database, not the mailbox, so this view lists them from
 * there. In All inboxes it lists every account's, newest first, each naming
 * its account.
 */
export function MutedThreadList({
  accounts,
  onOpenThread,
}: {
  /** All inboxes: the accounts to list mutes from. */
  accounts?: AllInboxesAccount[];
  onOpenThread: (threadId: string, emailAccountId: string) => void;
}) {
  const { emailAccountId } = useAccount();
  // Each read costs a provider call per muted thread, so a tab regaining
  // focus doesn't repeat it.
  const one = useSWR<MutedThreadsResponse>(
    accounts ? null : getAccountScopedKey(MUTED_PATH, emailAccountId),
    { revalidateOnFocus: false },
  );
  const all = useAllAccountsList<MutedThreadsResponse>(MUTED_PATH, accounts, {
    revalidateOnFocus: false,
  });
  const { isLoading, error, mutate } = accounts ? all : one;
  const rows: MutedRow[] = accounts
    ? (all.data?.byAccount ?? [])
        .flatMap(({ accountId, data }) =>
          data.threads.map((row) => ({ ...row, accountId })),
        )
        .sort(
          (a, b) =>
            new Date(b.mutedAt).getTime() - new Date(a.mutedAt).getTime(),
        )
    : (one.data?.threads ?? []).map((row) => ({
        ...row,
        accountId: emailAccountId,
      }));

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      {accounts ? (
        <AllInboxesFailedNotice
          accounts={accounts}
          failedAccountIds={all.data?.failedAccountIds ?? []}
          onRetry={() => mutate()}
        />
      ) : null}
      <LoadingContent loading={isLoading} error={error}>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-muted-foreground text-sm">
            Nothing muted. New replies to a muted conversation skip your inbox
            until you unmute it here.
          </div>
        ) : (
          <ul aria-label="Muted conversations">
            {rows.map((row) => (
              <MutedThreadRow
                accounts={accounts}
                key={`${row.accountId}:${row.id}`}
                onOpenThread={onOpenThread}
                onUnmuted={() => mutate().catch(() => undefined)}
                row={row}
              />
            ))}
          </ul>
        )}
      </LoadingContent>
    </div>
  );
}

function MutedThreadRow({
  row,
  accounts,
  onOpenThread,
  onUnmuted,
}: {
  row: MutedRow;
  accounts?: AllInboxesAccount[];
  onOpenThread: (threadId: string, emailAccountId: string) => void;
  onUnmuted: () => void;
}) {
  // Unmuting leaves the conversation where it is, as Gmail does; its next
  // reply comes to the inbox again.
  const { execute, isExecuting } = useAction(
    unmuteThreadsAction.bind(null, row.accountId),
    {
      onSuccess: () => {
        // The tab's notifier holds muted ids for a minute.
        forgetMutedThreadIds(row.accountId);
        toast.success("Unmuted");
        onUnmuted();
      },
      onError: (error) =>
        toast.error(
          getActionErrorMessage(error.error, {
            prefix: "Couldn't unmute this conversation",
          }),
        ),
    },
  );

  return (
    <li className="flex items-center gap-3 border-border border-b px-4 py-3">
      <AccountRowMarker accountId={row.accountId} accounts={accounts} />
      <button
        className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={() => onOpenThread(row.threadId, row.accountId)}
        type="button"
      >
        <p className="truncate font-medium text-foreground text-sm">
          {row.subject.trim() || "(no subject)"}
        </p>
        <p className="truncate text-muted-foreground text-xs">
          {[
            extractNameFromEmail(row.from) || row.from,
            decodeSnippet(row.snippet),
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      </button>
      <BellOffIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground"
      />
      <InlineActionButton
        disabled={isExecuting}
        onClick={() => execute({ threadIds: [row.threadId] })}
      >
        Unmute
      </InlineActionButton>
    </li>
  );
}
