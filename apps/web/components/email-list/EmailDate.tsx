"use client";

import { useHydrated } from "@/hooks/useHydrated";
import { cn } from "@/utils";
import { formatShortDate } from "@/utils/date";

export function EmailDate({
  date,
  className,
}: {
  date: Date;
  className?: string;
}) {
  // The date reads in the viewer's timezone, which a server render cannot
  // know, so server HTML leaves it out rather than hydrate a different one.
  const hydrated = useHydrated();
  return (
    <div
      className={cn(
        "flex-shrink-0 text-sm font-medium leading-5 text-muted-foreground",
        className,
      )}
    >
      {hydrated ? formatShortDate(date) : null}
    </div>
  );
}
