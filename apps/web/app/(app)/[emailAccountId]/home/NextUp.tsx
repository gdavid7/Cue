"use client";

import Link from "next/link";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { prefixPath } from "@/utils/path";
import { formatWhen } from "./today-format";

const ROW =
  "flex w-full items-center gap-3 border-border/60 border-b bg-background px-3.5 py-2.5 text-left";

/**
 * The next meetings and deadlines, soonest first, each opening where it lives:
 * the calendar event, the assignment, the task.
 */
export function NextUpList({
  items,
  now,
}: {
  items: GetHomeResponse["nextUp"];
  now: Date;
}) {
  return (
    <ul className="-mx-4 sm:mx-0 border-border/60 border-t">
      {items.map((item) => {
        const content = (
          <>
            <span className="w-20 shrink-0 text-muted-foreground text-xs tabular-nums sm:w-24">
              {formatWhen(item, now)}
            </span>
            <span className="min-w-0 flex-1 truncate text-foreground text-sm">
              {item.title}
            </span>
            <span className="max-w-[40%] shrink-0 truncate text-muted-foreground text-xs">
              {item.source}
              {/* The course or project only where there's room for it. */}
              {item.detail ? (
                <span className="max-sm:hidden"> · {item.detail}</span>
              ) : null}
            </span>
            {item.url ? (
              <span className="sr-only"> (opens in a new tab)</span>
            ) : null}
          </>
        );
        return (
          <li key={item.id}>
            {item.url ? (
              <a
                className={`${ROW} transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
                href={item.url}
                rel="noreferrer"
                target="_blank"
              >
                {content}
              </a>
            ) : (
              <div className={ROW}>{content}</div>
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
