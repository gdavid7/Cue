import type { LucideIcon } from "lucide-react";
import { cn } from "@/utils";

/**
 * Today's one status line, whatever the state: an icon, what's true, and a
 * quieter line under it. Green only when there's nothing left to do.
 */
export function TodayStatus({
  icon: Icon,
  tone,
  title,
  titleId,
  children,
}: {
  icon: LucideIcon;
  tone: "done" | "info";
  title: React.ReactNode;
  titleId?: string;
  children?: React.ReactNode;
}) {
  return (
    <div role="status">
      <h2
        className="flex items-start gap-2 font-title text-foreground text-lg"
        id={titleId}
      >
        {/* mt-1 centres the 20px badge on the title's 28px first line. */}
        <span
          aria-hidden
          className={cn(
            "mt-1 flex size-5 shrink-0 items-center justify-center rounded-full motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:animate-in motion-safe:duration-300",
            tone === "done"
              ? "bg-green-600/10 text-green-700 dark:bg-green-400/15 dark:text-green-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" strokeWidth={2.5} />
        </span>
        <span>{title}</span>
      </h2>
      {children ? (
        <p className="mt-1 text-muted-foreground text-sm">{children}</p>
      ) : null}
    </div>
  );
}
