"use client";

import { useState } from "react";
import useSWR from "swr";
import { AlarmClockIcon } from "lucide-react";
import { toast } from "sonner";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type {
  SnoozedThreadsResponse,
  UnsnoozeThreadsResponse,
} from "@/app/api/user/snoozed-threads/route";
import { formatSnoozeTime } from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
import { InlineActionButton } from "@/components/InlineActionButton";
import { LoadingContent } from "@/components/LoadingContent";
import { useAccount } from "@/providers/EmailAccountProvider";
import { extractNameFromEmail } from "@/utils/email";
import { fetchWithAccount } from "@/utils/fetch";
import { decodeSnippet } from "@/utils/gmail/decode";
import { getAccountScopedKey } from "@/utils/swr";

/**
 * Snoozes live in our database, not the mailbox, so this view lists them from
 * there, with when each conversation comes back.
 */
export function SnoozedThreadList({
  onOpenThread,
}: {
  onOpenThread: (threadId: string) => void;
}) {
  const { emailAccountId } = useAccount();
  const client = useOptionalMailClient();
  const [busyThreadId, setBusyThreadId] = useState<string | null>(null);
  const { data, isLoading, error, mutate } = useSWR<SnoozedThreadsResponse>(
    getAccountScopedKey("/api/user/snoozed-threads", emailAccountId),
  );
  const rows = data?.threads ?? [];

  const unsnooze = async (threadId: string) => {
    setBusyThreadId(threadId);
    try {
      const response = await fetchWithAccount({
        url: "/api/user/snoozed-threads",
        emailAccountId,
        init: {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ threadIds: [threadId] }),
        },
      });
      const result = response.ok
        ? ((await response.json()) as UnsnoozeThreadsResponse)
        : null;
      if (!result?.unsnoozedThreadIds.includes(threadId)) {
        toast.error("Couldn't unsnooze this conversation");
        return;
      }
      toast.success("Moved to inbox");
      client?.requestSync([emailAccountId]).catch(() => undefined);
      await mutate().catch(() => undefined);
    } catch {
      toast.error("Couldn't unsnooze this conversation");
    } finally {
      setBusyThreadId(null);
    }
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
      <LoadingContent loading={isLoading} error={error}>
        {rows.length === 0 ? (
          <div className="px-6 py-12 text-center text-muted-foreground text-sm">
            Nothing snoozed. Snoozed conversations wait here until it&apos;s
            time for them to come back.
          </div>
        ) : (
          <ul aria-label="Snoozed conversations">
            {rows.map((row) => (
              <li
                className="flex items-center gap-3 border-border border-b px-4 py-3"
                key={row.id}
              >
                <button
                  className="min-w-0 flex-1 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => onOpenThread(row.threadId)}
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
                <p className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
                  <AlarmClockIcon className="size-3.5" />
                  {row.status === "EXECUTING"
                    ? "Coming back now"
                    : formatSnoozeTime(new Date(row.scheduledFor))}
                </p>
                <InlineActionButton
                  disabled={busyThreadId !== null}
                  onClick={() => unsnooze(row.threadId)}
                >
                  Unsnooze
                </InlineActionButton>
              </li>
            ))}
          </ul>
        )}
      </LoadingContent>
    </div>
  );
}
