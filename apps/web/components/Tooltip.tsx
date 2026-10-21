"use client";

import { useEffect, useState } from "react";
import {
  ShortcutTooltipContent,
  type ShortcutTooltipItem,
} from "@/components/ShortcutTooltipContent";
import {
  Tooltip as ShadcnTooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface TooltipProps {
  // biome-ignore lint/suspicious/noExplicitAny: existing loose external shape
  children: React.ReactElement<any>;
  content?: string;
  contentComponent?: React.ReactNode;
  /** Keeps the tooltip closed. The trigger stays mounted, so focus on it survives. */
  hide?: boolean;
  /**
   * Opens on a tap, for touch. Off for a control whose click acts at once:
   * the tooltip would stay open and take the next Escape.
   */
  openOnClick?: boolean;
  shortcuts?: readonly ShortcutTooltipItem[];
  side?: "top" | "right" | "bottom" | "left";
}

export const Tooltip = ({
  children,
  content,
  contentComponent,
  shortcuts,
  hide,
  openOnClick = true,
  side,
}: TooltipProps) => {
  // Make tooltip work on mobile with a click
  const [isOpen, setIsOpen] = useState(false);
  useEffect(trackLastInput, []);

  return (
    <TooltipProvider delayDuration={200}>
      <ShadcnTooltip
        open={isOpen && !hide}
        onOpenChange={(open) => setIsOpen(open && !hide)}
      >
        <TooltipTrigger
          asChild
          onClick={openOnClick && !hide ? () => setIsOpen(!isOpen) : undefined}
          onFocus={(event) => {
            // Skips Radix's open-on-focus unless the user moved focus here.
            if (!movedFocusByKeyboard()) event.preventDefault();
          }}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side={side}>
          {contentComponent ||
            (shortcuts ? (
              <ShortcutTooltipContent shortcuts={shortcuts} />
            ) : (
              <p className="max-w-xs">{content}</p>
            ))}
        </TooltipContent>
      </ShadcnTooltip>
    </TooltipProvider>
  );
};

// A tooltip opens on focus only when the user moved focus with Tab or the
// arrow keys. Focus a dialog puts back as it closes, after Escape or a
// click, would otherwise open one over the controls beside its trigger
// and swallow their clicks.
const NAVIGATION_KEYS = new Set([
  "Tab",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);
let lastInput: string | null = null;
let isTrackingInput = false;

function trackLastInput() {
  if (isTrackingInput) return;
  isTrackingInput = true;
  document.addEventListener(
    "keydown",
    (event) => {
      lastInput = event.key;
    },
    true,
  );
  document.addEventListener(
    "pointerdown",
    () => {
      lastInput = "pointer";
    },
    true,
  );
}

function movedFocusByKeyboard() {
  return lastInput !== null && NAVIGATION_KEYS.has(lastInput);
}
