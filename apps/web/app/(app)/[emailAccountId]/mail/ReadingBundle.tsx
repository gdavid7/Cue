"use client";

import { ChevronLeftIcon, ChevronRightIcon, NewspaperIcon } from "lucide-react";
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
  layout,
  onOpen,
}: {
  senders: string;
  unreadCount: number;
  layout: MailLayoutMode;
  onOpen: () => void;
}) {
  // Rows go compact on a phone, so this one does too.
  const isMobile = useIsMobile();
  const isWide = layout === "list" && !isMobile;
  const unread = unreadCount > 0;
  return (
    <button
      aria-label={`Reading, from ${senders}${unread ? `, ${unreadCount} unread` : ""}`}
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
          {unreadCount}
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
  canMarkRead,
  canArchive,
  onBack,
  onMarkAllRead,
  onArchiveAll,
}: {
  canMarkRead: boolean;
  canArchive: boolean;
  onBack: () => void;
  onMarkAllRead: () => void;
  onArchiveAll: () => void;
}) {
  const actionClassName =
    "relative rounded text-muted-foreground text-xs underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']";
  return (
    <div className="flex shrink-0 items-center gap-3 border-border border-b px-3 py-1.5">
      <button
        aria-label="Back to Inbox"
        className="-ml-1 relative flex items-center gap-0.5 rounded px-1 py-0.5 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:text-foreground pointer-coarse:after:absolute pointer-coarse:after:-inset-3 pointer-coarse:after:content-['']"
        onClick={onBack}
        type="button"
      >
        <ChevronLeftIcon aria-hidden className="size-3.5" />
        Inbox
      </button>
      <span className="ml-auto flex items-center gap-4">
        <button
          className={actionClassName}
          disabled={!canMarkRead}
          onClick={onMarkAllRead}
          type="button"
        >
          Mark all read
        </button>
        <button
          className={actionClassName}
          disabled={!canArchive}
          onClick={onArchiveAll}
          type="button"
        >
          Archive all
        </button>
      </span>
    </div>
  );
}
