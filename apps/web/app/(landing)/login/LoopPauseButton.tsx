"use client";

import { PauseIcon, PlayIcon } from "lucide-react";
import { cn } from "@/utils";

// Moving content that starts on its own needs a way to stop it (WCAG 2.2.2).
export function LoopPauseButton({
  paused,
  onToggle,
  className,
}: {
  paused: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const Icon = paused ? PlayIcon : PauseIcon;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={paused ? "Play animation" : "Pause animation"}
      className={cn(
        "relative flex size-7 items-center justify-center rounded-full after:absolute after:-inset-2 after:content-[''] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
    </button>
  );
}
