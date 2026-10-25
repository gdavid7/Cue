"use client";

import { ChevronLeftIcon, ChevronRightIcon, NewspaperIcon } from "lucide-react";
import type { Ref } from "react";
import { formatReadingCount } from "@/app/(app)/[emailAccountId]/mail/reading-lane";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/utils";

/**
 * The inbox's newsletters as one calm row, in place of a row each. Pressing
 * it opens the Reading lane to read through them.
 */
export function ReadingBundleRow({
  senders,
  unreadCount,
  hasMore,
  layout,
  onOpen,
}: {
  senders: string;
  /** Unread among the newsletters loaded so far. */
  unreadCount: number;
  /** More newsletters are still to load, so the count is "at least". */
  hasMore: boolean;
  layout: MailLayoutMode;
  onOpen: () => void;
}) {
  // Rows go compact on a phone, so this one does too.
  const isMobile = useIsMobile();
  const isWide = layout === "list" && !isMobile;
  const unread = unreadCount > 0;
  const count = formatReadingCount(unreadCount, hasMore);
  return (
    <button
      aria-label={`Reading, from ${senders}${unread ? `, ${count} unread` : ""}`}
      className={cn(
        "flex w-full shrink-0 items-center border-border/60 border-b text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset active:bg-muted",
        isWide ? "gap-2.5 py-2.5 pr-5 pl-3" : "gap-2 px-3.5 py-2.5",
      )}
      data-reading-bundle
      onClick={onOpen}
      type="button"
    >
      {/* Where rows keep their checkbox and unread dot. */}
      <span className="flex w-[1.875rem] shrink-0">
        <NewspaperIcon aria-hidden className="size-3.5 text-muted-foreground" />
      </span>
      <span
        className={cn(
          "shrink-0 text-sm",
          isWide && "w-64",
          unread ? "font-semibold text-foreground" : "text-muted-foreground",
        )}
      >
        Reading
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">
        From {senders}
      </span>
      {unread ? (
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      ) : null}
      <ChevronRightIcon
        aria-hidden
        className="size-4 shrink-0 text-muted-foreground"
      />
    </button>
  );
}

/**
 * Heads the Reading lane: the way back to the inbox the lane was opened from,
 * and what clears the whole bundle at once.
 */
export function ReadingLaneBar({
  count,
  hasMore,
  canMarkRead,
  canArchive,
  busy,
  backRef,
  onBack,
  onMarkAllRead,
  onArchiveAll,
}: {
  /** Newsletters loaded so far. */
  count: number;
  hasMore: boolean;
  canMarkRead: boolean;
  canArchive: boolean;
  /** Loading the rest of the lane before acting on all of it. */
  busy: boolean;
  backRef: Ref<HTMLButtonElement>;
  onBack: () => void;
  onMarkAllRead: () => void;
  onArchiveAll: () => void;
}) {
  const actionClassName =
    "relative rounded text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']";
  return (
    <div
      aria-busy={busy}
      className="flex shrink-0 items-center gap-3 border-border border-b px-3 py-1.5"
    >
      <button
        aria-label="Back to Inbox"
        ref={backRef}
        className="-ml-1 relative flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
        onClick={onBack}
        type="button"
      >
        <ChevronLeftIcon aria-hidden className="size-3.5" />
        Inbox
      </button>
      {count ? (
        <span className="text-muted-foreground text-xs tabular-nums">
          {count === 1 && !hasMore
            ? "1 newsletter"
            : `${formatReadingCount(count, hasMore)} newsletters`}
        </span>
      ) : null}
      <span className="ml-auto flex items-center gap-4">
        <button
          className={actionClassName}
          disabled={busy || !canMarkRead}
          onClick={onMarkAllRead}
          type="button"
        >
          Mark all read
        </button>
        <button
          className={actionClassName}
          disabled={busy || !canArchive}
          onClick={onArchiveAll}
          type="button"
        >
          Archive all
        </button>
      </span>
    </div>
  );
}
