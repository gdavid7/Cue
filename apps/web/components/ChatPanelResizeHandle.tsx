"use client";

import { useRef } from "react";
import {
  getChatPanelWidth,
  getChatPanelWidthBounds,
  previewChatPanelWidth,
  resetChatPanelWidth,
  saveChatPanelWidth,
  useChatPanelWidth,
} from "@/hooks/useChatPanelWidth";
import { cn } from "@/utils";

const KEYBOARD_STEP = 16;
const KEYBOARD_LARGE_STEP = 64;

/** Sits on the panel's left edge: dragging left widens the panel. */
export function ChatPanelResizeHandle({ className }: { className?: string }) {
  const width = useChatPanelWidth();
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);
  const { min, max } = getChatPanelWidthBounds();

  const finishDrag = () => {
    if (!drag.current) return;
    drag.current = null;
    saveChatPanelWidth(getChatPanelWidth());
  };

  return (
    <div
      role="separator"
      aria-label="Resize assistant panel"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={cn(
        "group/resize absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize touch-none select-none rounded-sm outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startX: event.clientX, startWidth: width };
        previewChatPanelWidth(width);
      }}
      onPointerMove={(event) => {
        if (!drag.current) return;
        previewChatPanelWidth(
          drag.current.startWidth + drag.current.startX - event.clientX,
        );
      }}
      onPointerUp={finishDrag}
      onPointerCancel={finishDrag}
      onLostPointerCapture={finishDrag}
      onDoubleClick={resetChatPanelWidth}
      onKeyDown={(event) => {
        const next = getKeyboardWidth(event, width, min, max);
        if (next === null) return;
        event.preventDefault();
        saveChatPanelWidth(next);
      }}
    >
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-transparent",
          "transition-colors duration-150 motion-reduce:transition-none",
          // The delay keeps the line from flickering as the pointer passes over.
          "group-hover/resize:bg-ring/40 group-hover/resize:delay-150",
          "group-active/resize:bg-ring/60 group-active/resize:delay-0",
        )}
      />
    </div>
  );
}

function getKeyboardWidth(
  event: React.KeyboardEvent,
  width: number,
  min: number,
  max: number,
) {
  const step = event.shiftKey ? KEYBOARD_LARGE_STEP : KEYBOARD_STEP;
  switch (event.key) {
    case "ArrowLeft":
      return width + step;
    case "ArrowRight":
      return width - step;
    case "Home":
      return min;
    case "End":
      return max;
    default:
      return null;
  }
}
