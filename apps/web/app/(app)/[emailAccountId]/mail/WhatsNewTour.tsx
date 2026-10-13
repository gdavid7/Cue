"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";

/**
 * Each step points at real mail UI. Targets that aren't on screen (no insight
 * yet, no email open) fall back to the next best element, then the list.
 */
const STEPS = [
  {
    title: "Same inbox. Nothing moved.",
    body: "Every email is still here, in order. Cue only adds to it.",
    targets: ['[role="listbox"][aria-label="Conversations"]'],
  },
  {
    title: "The line under each email",
    body: "What it asks of you, any deadline, and “Reply ready” when a reply is waiting for you.",
    targets: ['[data-testid="thread-insight"]', '[role="option"]'],
  },
  {
    title: "Relevant context and suggested replies",
    body: "Open an email to see related email, meetings and files. A reply is suggested only when every fact in it is backed by a quote.",
    targets: ['[data-testid="thread-context-panel"]', '[role="option"]'],
  },
] as const;

const FALLBACK_TARGET = STEPS[0].targets[0];

export function WhatsNewTour({ onClose }: { onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  // Looked up on every measure rather than once, so the popover follows the
  // list as it loads, scrolls and resizes. Only the target's top edge is used:
  // the list and the context panel fill the screen, and a popover placed below
  // them would land off it.
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const rect = findTarget(step.targets)?.getBoundingClientRect();
          if (!rect)
            return new DOMRect(window.innerWidth / 2, window.innerHeight / 3);
          return new DOMRect(
            rect.x,
            rect.y,
            rect.width,
            Math.min(rect.height, 40),
          );
        },
      },
    }),
    [step],
  );

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        key={stepIndex}
        side="bottom"
        align="start"
        collisionPadding={16}
        aria-label="What's new in Cue"
        className="w-80"
        // Clicking around the mail shouldn't end the tour on the first step.
        onInteractOutside={(event) => event.preventDefault()}
      >
        <p className="text-[11px] text-muted-foreground">
          {stepIndex + 1} of {STEPS.length}
        </p>
        <h3 className="mt-1 font-medium text-sm">{step.title}</h3>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {step.body}
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          {!isLast && (
            <Button size="xs-2" variant="ghost" onClick={onClose}>
              Skip tour
            </Button>
          )}
          <Button
            size="xs-2"
            onClick={() => (isLast ? onClose() : setStepIndex(stepIndex + 1))}
          >
            {isLast ? "Done" : "Next"}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function findTarget(selectors: readonly string[]) {
  for (const selector of [...selectors, FALLBACK_TARGET]) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return null;
}
