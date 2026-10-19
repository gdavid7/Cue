import { AlertCircleIcon, InfoIcon } from "lucide-react";
import type React from "react";
import { cn } from "@/utils";

export function AppAlertBanner({
  title,
  description,
  action,
  className,
  tone = "alert",
}: {
  title: string;
  description: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  /** "notice" is for heads-ups that aren't faults: calmer colors, no alert role. */
  tone?: "alert" | "notice";
}) {
  const isNotice = tone === "notice";
  const Icon = isNotice ? InfoIcon : AlertCircleIcon;
  return (
    <div
      role={isNotice ? "status" : "alert"}
      className={cn(
        "relative z-10 flex w-full flex-col gap-4 border-y px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:pl-[calc(var(--mail-rail-width,0px)+1.5rem)]",
        isNotice
          ? "border-amber-200 bg-amber-50 text-amber-950 motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:animate-in motion-safe:duration-200 motion-reduce:animate-in motion-reduce:fade-in-0 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50"
          : "border-red-200 bg-red-50 text-red-950 dark:border-red-900 dark:bg-red-950 dark:text-red-50",
        className,
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <Icon
          className={cn(
            "mt-0.5 size-5 shrink-0",
            isNotice
              ? "text-amber-600 dark:text-amber-400"
              : "text-red-600 dark:text-red-400",
          )}
        />
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          <div
            className={cn(
              "mt-1 text-sm",
              isNotice
                ? "text-amber-800 dark:text-amber-200"
                : "text-red-800 dark:text-red-200",
            )}
          >
            {description}
          </div>
        </div>
      </div>
      {action ? <div className="shrink-0 pl-8 sm:pl-0">{action}</div> : null}
    </div>
  );
}
