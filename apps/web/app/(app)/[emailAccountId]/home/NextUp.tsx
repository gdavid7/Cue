"use client";

import Link from "next/link";
import type { MailLayoutMode } from "@/app/(app)/[emailAccountId]/mail/types";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { cn } from "@/utils";
import { prefixPath } from "@/utils/path";
import { formatWhen } from "./today-format";

// The inbox row's insets (MailThreadRow), so Next up lines up with the lanes
// around it: text starts past the unread-dot slot and ends where dates do.
const ROW: Record<MailLayoutMode, string> = {
  list: "flex items-center gap-2.5 pr-5 pl-8",
  split:
    "grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-0.5 pr-3.5 pl-8",
};

/**
 * The next meetings and deadlines, soonest first, each opening where it lives:
 * the calendar event, the assignment, the task. Wide, one line led by the
 * time. Narrow, like an inbox row: the title gets the line, the time sits
 * where the date does, and the source goes under the title.
 */
export function NextUpList({
  items,
  now,
  layout,
}: {
  items: GetHomeResponse["nextUp"];
  now: Date;
  layout: MailLayoutMode;
}) {
  const wide = layout === "list";
  const row = cn(
    ROW[layout],
    "w-full border-border/60 border-b bg-background py-2.5 text-left",
  );
  return (
    <ul className="-mx-4 sm:mx-0 border-border/60 border-t">
      {items.map((item) => {
        const content = (
          <>
            <span
              className={cn(
                "whitespace-nowrap text-muted-foreground text-xs tabular-nums",
                wide ? "w-24 shrink-0" : "col-start-2 row-start-1",
              )}
            >
              {formatWhen(item, now)}
            </span>
            <span
              className={cn(
                "min-w-0 truncate text-foreground text-sm",
                wide ? "flex-1" : "col-start-1 row-start-1",
              )}
            >
              {item.title}
            </span>
            <span
              className={cn(
                "truncate text-muted-foreground text-xs",
                wide ? "max-w-[40%] shrink-0" : "col-span-2",
              )}
            >
              {item.source}
              {item.detail ? ` · ${item.detail}` : null}
            </span>
            {item.url ? (
              <span className="sr-only"> (opens in a new tab)</span>
            ) : null}
          </>
        );
        return (
          <li
            // Deadlines arrive after Today: they fade in where they belong
            // rather than appear at once, and simply appear with reduced motion.
            className={
              item.kind === "deadline"
                ? "motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
                : undefined
            }
            key={item.id}
          >
            {item.url ? (
              <a
                className={cn(
                  row,
                  "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:bg-muted",
                )}
                href={item.url}
                rel="noreferrer"
                target="_blank"
              >
                {content}
              </a>
            ) : (
              <div className={row}>{content}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One quiet line offering to connect an app or calendar Today could read. */
export function ConnectLine({
  emailAccountId,
  name,
  path,
  purpose,
}: {
  emailAccountId: string;
  name: string;
  path: "/calendars" | "/integrations";
  purpose: string;
}) {
  return (
    <p className="text-muted-foreground text-sm">
      <Link
        className="inline-flex items-center font-medium text-blue-600 underline-offset-2 hover:underline max-sm:min-h-11 dark:text-blue-400"
        href={prefixPath(emailAccountId, path)}
      >
        Connect {name}
      </Link>{" "}
      {purpose}
    </p>
  );
}
