"use client";

import { addDays } from "date-fns/addDays";
import { startOfDay } from "date-fns/startOfDay";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { markRumRowsShown } from "@/utils/analytics/rum-actions";
import { MailboxThreadList } from "@inboxzero/mail-ui/MailboxSurface";
import { ThreadRow } from "@/app/(app)/[emailAccountId]/mail/ThreadRow";
import type { ThreadRowActionHandlers } from "@/app/(app)/[emailAccountId]/mail/ThreadRowActions";
import type {
  ListThread,
  MailLayoutMode,
} from "@/app/(app)/[emailAccountId]/mail/types";
import {
  getListThreadEmailAccountId,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { getAccountColorClassName } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { LoadingMiniSpinner } from "@/components/Loading";
import { Button } from "@/components/ui/button";
import type { EmailLabels } from "@/providers/email-label-types";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useIsMobile } from "@/hooks/use-mobile";
import { useHydrated } from "@/hooks/useHydrated";
import { useInboxInsights } from "@/hooks/useInboxInsights";
import { useSentMessageOpensForThreads } from "@/hooks/useSentMessageOpens";
import { cn } from "@/utils";
import { formatDateGroupLabel } from "@/utils/date";
import { getThreadTimestamp } from "@/utils/threads/sort";
import { GmailLabel } from "@/utils/gmail/label";

const NO_LABELS: EmailLabels = {};

export type ThreadListProps = {
  threads: ListThread[];
  emptyMessage?: string;
  layout: MailLayoutMode;
  expandedPreview: boolean;
  userEmail: string;
  userLabels: EmailLabels;
  labelsByAccount?: Record<string, EmailLabels>;
  /** Each All inboxes account's position, which picks its row marker color. */
  accountColorIndexById?: Record<string, number>;
  /** The rows are the inbox's, so each account marker names an inbox. */
  inInbox?: boolean;
  selectionEnabled?: boolean;
  /** The row `J`/`K` sits on. */
  focusedIndex: number;
  isSelected: (threadId: string) => boolean;
  selectedCount: number;
  onOpenThread: (index: number) => void;
  onToggleSelect: (index: number) => void;
  onSelectRangeTo: (index: number) => void;
  showLoadMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
  /** Identity of the current view so prefetch state does not leak across splits. */
  listKey: string;
  showSentOpenStatus?: boolean;
  rowActions?: ThreadRowActionHandlers;
  /**
   * Holds off on inbox insights, e.g. while the first sync is still filling the
   * list: each new batch of rows would otherwise ask again, and every unseen
   * email costs the server a provider read and a model call.
   */
  insightsPaused?: boolean;
};

export const ThreadList = memo(function ThreadList({
  threads,
  emptyMessage = "Nothing here right now.",
  layout,
  expandedPreview,
  userEmail,
  userLabels,
  labelsByAccount,
  accountColorIndexById,
  inInbox,
  selectionEnabled = true,
  focusedIndex,
  isSelected,
  selectedCount,
  onOpenThread,
  onToggleSelect,
  onSelectRangeTo,
  showLoadMore,
  isLoadingMore,
  onLoadMore,
  listKey,
  showSentOpenStatus = false,
  rowActions,
  insightsPaused = false,
}: ThreadListProps) {
  const { emailAccountId } = useAccount();
  const isMobile = useIsMobile();
  const dayStart = useDayStart();
  const hasRows = threads.length > 0;
  // The list only renders empty once it has loaded; until then the screen
  // shows its loading state instead.
  useEffect(() => {
    markRumRowsShown(hasRows ? "ok" : "empty");
  }, [hasRows]);
  const sentThreadIds = useMemo(
    () =>
      showSentOpenStatus
        ? threads
            .filter((thread) =>
              thread.messages.at(-1)?.labelIds?.includes(GmailLabel.SENT),
            )
            .map((thread) => thread.id)
        : [],
    [showSentOpenStatus, threads],
  );
  const { data: sentMessageOpens } =
    useSentMessageOpensForThreads(sentThreadIds);
  const insightItems = useMemo(
    () =>
      threads.flatMap((thread) => {
        const messageId =
          thread.latestMessageId ??
          thread.messages.findLast(
            (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
          )?.id;
        return messageId
          ? [
              {
                key: getListThreadKey(thread),
                emailAccountId: getListThreadEmailAccountId(
                  thread,
                  emailAccountId,
                ),
                threadId: thread.id,
                messageId,
              },
            ]
          : [];
      }),
    [threads, emailAccountId],
  );
  const { data: insights } = useInboxInsights(insightItems, {
    enabled: !insightsPaused,
  });
  const groupHeaderClassName = cn(
    "pt-4 pr-5 pb-1.5 font-normal text-muted-foreground text-sm",
    selectionEnabled ? "pl-[3.25rem]" : "pl-8",
  );
  const getGroupLabel = useCallback(
    (thread: ListThread) => {
      const timestamp = getThreadTimestamp(thread);
      return timestamp && dayStart !== null
        ? formatDateGroupLabel(new Date(timestamp), new Date(dayStart))
        : null;
    },
    [dayStart],
  );

  return (
    <MailboxThreadList
      emptyMessage={emptyMessage}
      focusedIndex={focusedIndex}
      getGroupLabel={getGroupLabel}
      getKey={getListThreadKey}
      groupHeaderClassName={groupHeaderClassName}
      isLoadingMore={isLoadingMore}
      isSelected={isSelected}
      items={threads}
      listKey={listKey}
      loadMoreButton={
        <Button onClick={onLoadMore} size="sm" variant="outline">
          Load more
        </Button>
      }
      loadingMoreIndicator={
        <div className="flex items-center gap-2 text-muted-foreground text-xs">
          <LoadingMiniSpinner />
          Loading more
        </div>
      }
      onLoadMore={onLoadMore}
      onOpen={onOpenThread}
      onSelectRangeTo={onSelectRangeTo}
      onToggleSelect={onToggleSelect}
      renderItem={(row) => (
        <ThreadRow
          compact={isMobile}
          expandedPreview={expandedPreview}
          hasAnySelection={row.hasAnySelection}
          index={row.index}
          isFocused={row.isFocused}
          isSelected={row.isSelected}
          key={row.rowKey}
          layout={layout}
          onOpen={row.onOpen}
          onSelectRangeTo={row.onSelectRangeTo}
          onToggleSelect={row.onToggleSelect}
          rowActions={rowActions}
          rowRef={row.rowRef}
          selectionEnabled={row.selectionEnabled}
          sentMessageOpen={
            showSentOpenStatus
              ? sentMessageOpens?.opens[row.item.messages.at(-1)?.id ?? ""]
              : undefined
          }
          insightData={insights?.[getListThreadKey(row.item)]}
          accountColorClassName={
            "account" in row.item
              ? getAccountColorClassName(
                  accountColorIndexById?.[row.item.account.id] ?? 0,
                )
              : undefined
          }
          inInbox={inInbox}
          thread={row.item}
          userEmail={userEmail}
          userLabels={
            "account" in row.item
              ? (labelsByAccount?.[row.item.account.id] ?? NO_LABELS)
              : userLabels
          }
        />
      )}
      selectedCount={selectedCount}
      selectionEnabled={selectionEnabled}
      showLoadMore={showLoadMore}
    />
  );
});

/**
 * Refreshes idle lists at midnight and when a suspended tab becomes active.
 * Null in server HTML and while hydrating: days fall in the viewer's
 * timezone, which the server cannot know.
 */
function useDayStart() {
  const hydrated = useHydrated();
  const [, setDayStart] = useState(() => startOfDay(new Date()).getTime());
  // Read the clock on every render, even if a background timer has not fired yet.
  const dayStart = startOfDay(new Date()).getTime();

  useEffect(() => {
    const refresh = () => setDayStart(startOfDay(new Date()).getTime());
    const timeout = setTimeout(
      refresh,
      Math.max(0, addDays(new Date(dayStart), 1).getTime() - Date.now()),
    );
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [dayStart]);

  return hydrated ? dayStart : null;
}
