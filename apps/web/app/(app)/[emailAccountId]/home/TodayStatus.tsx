import type { LucideIcon } from "lucide-react";
import { cn } from "@/utils";

/**
 * Today's one status line, whatever the state: an icon, what's true, and a
 * quieter line under it. Green only when there's nothing left to do. A
 * "quiet" status is a secondary nag, such as a setting that's off, so its
 * line reads as body text and stays out of the heading outline.
 */
export function TodayStatus({
  icon: Icon,
  tone,
  title,
  titleId,
  children,
}: {
  icon: LucideIcon;
  tone: "done" | "info" | "quiet";
  title: React.ReactNode;
  titleId?: string;
  children?: React.ReactNode;
}) {
  const quiet = tone === "quiet";
  const Line = quiet ? "p" : "h2";
  return (
    <div role="status">
      <Line
        className={cn(
          "flex items-start gap-2",
          quiet
            ? "text-muted-foreground text-sm"
            : "font-title text-foreground text-lg",
        )}
        id={titleId}
      >
        {/* Centres the 20px badge on the first line: 20px body, 28px title. */}
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full motion-safe:fade-in motion-safe:zoom-in-75 motion-safe:animate-in motion-safe:duration-300",
            !quiet && "mt-1",
            tone === "done"
              ? "bg-green-600/10 text-green-700 dark:bg-green-400/15 dark:text-green-400"
              : "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-3.5" strokeWidth={2.5} />
        </span>
        <span>{title}</span>
      </Line>
      {children ? (
        <p className="mt-1 text-muted-foreground text-sm">{children}</p>
      ) : null}
    </div>
  );
}
