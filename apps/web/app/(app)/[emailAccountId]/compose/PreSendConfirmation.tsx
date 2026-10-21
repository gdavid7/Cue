"use client";

import { CircleAlertIcon } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";
import type { PreSendWarning, PreSendWarningFix } from "./pre-send-warnings";

/**
 * A second look before a send goes out. It sits beside the Send button rather
 * than over the message, so the draft stays in view and editable: Enter sends
 * anyway, Escape goes back to the draft.
 */
export function PreSendConfirmation({
  warnings,
  onSend,
  onFix,
  onDismiss,
  className,
}: {
  warnings: PreSendWarning[];
  onSend: () => void;
  onFix: (fix: PreSendWarningFix) => void;
  onDismiss: () => void;
  className?: string;
}) {
  const titleId = useId();
  const listId = useId();
  const containerRef = useRef<HTMLFieldSetElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const fixRef = useRef<HTMLButtonElement>(null);
  const fix = warnings[0]?.fix ?? "body";

  useEffect(() => {
    sendRef.current?.focus();
  }, []);

  // Window capture runs before the compose dialog's own Escape and the send
  // shortcut, so these keys only ever answer this question. Escape anywhere
  // in the composer steps back to the draft rather than closing it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container || !(event.target instanceof Node)) return;
      if (event.isComposing) return;
      if (event.key === "Escape" && container.form?.contains(event.target)) {
        event.preventDefault();
        event.stopPropagation();
        onDismiss();
        return;
      }
      if (
        event.key === "Enter" &&
        container.contains(event.target) &&
        event.target !== fixRef.current
      ) {
        event.preventDefault();
        event.stopPropagation();
        onSend();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onDismiss, onSend]);

  return (
    <fieldset
      aria-describedby={listId}
      aria-labelledby={titleId}
      className={cn(
        "m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm dark:border-amber-900 dark:bg-amber-950/60",
        // Rises from the Send button it answers; a plain fade with reduced motion.
        "fade-in-0 animate-in duration-150 ease-out motion-safe:slide-in-from-bottom-1",
        className,
      )}
      data-testid="pre-send-confirmation"
      ref={containerRef}
    >
      <CircleAlertIcon
        aria-hidden
        className="size-4 shrink-0 self-start text-amber-600 mt-0.5 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1">
        <p className="sr-only" id={titleId}>
          Before you send
        </p>
        <ul className="space-y-0.5 text-foreground" id={listId}>
          {warnings.map((warning) => (
            <li className="break-words" key={warning.id}>
              {warning.message}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          onClick={() => onFix(fix)}
          ref={fixRef}
          size="sm"
          type="button"
          variant="ghost"
        >
          {FIX_LABELS[fix]}
        </Button>
        <Button onClick={onSend} ref={sendRef} size="sm" type="button">
          Send anyway
        </Button>
      </div>
    </fieldset>
  );
}

const FIX_LABELS: Record<PreSendWarningFix, string> = {
  attach: "Attach files",
  subject: "Add subject",
  recipients: "Edit recipients",
  body: "Edit message",
};
