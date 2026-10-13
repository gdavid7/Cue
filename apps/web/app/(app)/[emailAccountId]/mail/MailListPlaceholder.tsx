import { Loader2Icon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

const ROW_WIDTHS = ["w-3/4", "w-2/3", "w-5/6", "w-1/2", "w-4/5", "w-3/5"];

/**
 * Stands in for the list while mail is still arriving, so a brand-new account
 * never reads "No emails" for an inbox that simply hasn't synced yet.
 */
export function MailListPlaceholder({ message }: { message?: string }) {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      data-mail-list-placeholder
    >
      {message ? <MailLoadingNote message={message} /> : null}
      <div aria-hidden className="flex flex-col">
        {ROW_WIDTHS.map((width) => (
          <div
            key={width}
            className="flex items-start gap-3 border-border border-b px-5 py-3"
          >
            <Skeleton className="mt-0.5 size-4 shrink-0 rounded" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between gap-4">
                <Skeleton className="h-3 w-32" />
                <Skeleton className="h-3 w-10" />
              </div>
              <Skeleton className={`h-3 ${width}`} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Says which mail is still arriving, above a list that may already show some. */
export function MailLoadingNote({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 px-5 pt-4 pb-2 text-muted-foreground text-sm"
    >
      <Loader2Icon className="size-4 animate-spin" aria-hidden />
      {message}
    </p>
  );
}
