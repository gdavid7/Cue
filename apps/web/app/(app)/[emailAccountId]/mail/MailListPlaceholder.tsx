import { MailListToolbarSurface } from "@inboxzero/mail-ui/MailListToolbarSurface";
import { Loader2Icon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/utils";

const ROW_WIDTHS = ["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/5", "w-3/5"];
const TAB_WIDTHS = ["w-10", "w-14", "w-16", "w-12"];

/**
 * Stands in for the list while mail is still arriving, so a brand-new account
 * never reads "No emails" for an inbox that simply hasn't synced yet. Rows
 * mirror `MailThreadRow` line for line so nothing jumps when mail lands.
 */
export function MailListPlaceholder({
  message,
  layout = "list",
  withChrome = false,
}: {
  message: string;
  /** Matches the real list: split view stacks each row. */
  layout?: "list" | "split";
  /** Draws the toolbar and tab row too, for when the shell hasn't mounted. */
  withChrome?: boolean;
}) {
  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
      data-mail-list-placeholder
    >
      {withChrome ? <PlaceholderChrome /> : null}
      <MailLoadingNote message={message} />
      <div aria-hidden className="flex flex-col">
        {ROW_WIDTHS.map((width) => (
          <PlaceholderRow key={width} width={width} layout={layout} />
        ))}
      </div>
    </div>
  );
}

/**
 * Says which mail is still arriving, over a list that may already show some.
 * It floats at the foot of the nearest positioned container rather than
 * taking a line above the rows, so the rows stay put as it comes and goes:
 * from the server's rows to the engine's, and when the first sync ends.
 */
export function MailLoadingNote({ message }: { message: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-4">
      <p
        role="status"
        className="flex max-w-full items-center gap-2 rounded-full border border-border bg-background/95 px-3 py-1.5 text-muted-foreground text-xs shadow-sm"
      >
        <Loader2Icon
          className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden
        />
        <span className="truncate">{message}</span>
      </p>
    </div>
  );
}

/** The toolbar and tab row, for when the shell hasn't mounted. */
export function PlaceholderChrome() {
  return (
    <div aria-hidden>
      <MailListToolbarSurface>
        <Skeleton className="h-8 min-w-0 flex-1 rounded-lg" />
        <Skeleton className="size-8 shrink-0 rounded-md" />
        <Skeleton className="size-8 shrink-0 rounded-md" />
      </MailListToolbarSurface>
      <div className="flex items-center gap-1 border-border border-b px-3 pb-2">
        {TAB_WIDTHS.map((width) => (
          <Skeleton key={width} className={cn("h-5 rounded-full", width)} />
        ))}
      </div>
    </div>
  );
}

export function PlaceholderRow({
  width,
  layout,
}: {
  width: string;
  layout: "list" | "split";
}) {
  const stacked = (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
      <div className="flex h-5 items-center justify-between gap-4">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-3 w-10" />
      </div>
      <div className="flex h-5 items-center">
        <Skeleton className={cn("h-3", width)} />
      </div>
      <div className="flex h-4 items-center">
        <Skeleton className="h-2.5 w-11/12" />
      </div>
    </div>
  );

  if (layout === "split") {
    return (
      <div className="flex items-start gap-2 border-border/60 border-b px-3.5 py-2.5">
        <span className="w-2.5 shrink-0" />
        {stacked}
      </div>
    );
  }

  // One line from md up, like a wide row; stacked on a phone, like a compact one.
  return (
    <div className="flex items-start gap-2 border-border/60 border-b px-3.5 py-2.5 md:items-center md:gap-2.5 md:pr-5 md:pl-3">
      <span className="w-2.5 shrink-0" />
      <div className="contents max-md:hidden">
        <div className="flex h-5 w-64 shrink-0 items-center">
          <Skeleton className="h-3 w-32" />
        </div>
        <div className="flex h-5 min-w-0 flex-1 items-center">
          <Skeleton className={cn("h-3", width)} />
        </div>
        <div className="flex h-5 w-16 shrink-0 items-center justify-end">
          <Skeleton className="h-3 w-10" />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 md:hidden">{stacked}</div>
    </div>
  );
}
