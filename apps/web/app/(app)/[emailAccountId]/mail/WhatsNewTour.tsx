"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { cn } from "@/utils";

/** The list, or its placeholder while the first sync is still running. */
const LIST_SELECTOR =
  '[role="listbox"][aria-label="Conversations"], [data-mail-list-placeholder]';
const INSIGHT_SELECTOR = '[data-testid="thread-insight"]';
const POLL_MS = 500;
/** Insights are written in the background; give up on them after a minute. */
export const INSIGHT_WAIT_MS = 60_000;

type TourStep = {
  title: string;
  body: string;
  findTarget: () => Element | null;
  /** How long the step waits for its target before it is skipped. */
  waitForTargetMs: number;
  /** Shown on the list while waiting, so the wait isn't silent. */
  waitingMessage?: string;
};

/** Each step appears only once the thing it points at is on screen. */
const STEPS: TourStep[] = [
  {
    title: "The line under each email",
    body: "What it asks of you, any deadline, and “Reply ready” when a reply is waiting for you.",
    findTarget: () => document.querySelector(INSIGHT_SELECTOR),
    waitForTargetMs: INSIGHT_WAIT_MS,
    waitingMessage:
      "Cue is reading your recent mail. Notes appear under emails in a minute.",
  },
  {
    title: "Relevant context and suggested replies",
    body: "Open an email to see related mail, meetings and files, and a reply when Cue can back every fact.",
    findTarget: () =>
      document.querySelector(INSIGHT_SELECTOR)?.closest('[role="option"]') ??
      null,
    waitForTargetMs: 0,
  },
];

export type TourStepView = "show" | "wait" | "skip";

export function getTourStepView({
  hasTarget,
  waitedMs,
  waitForTargetMs,
}: {
  hasTarget: boolean;
  waitedMs: number;
  waitForTargetMs: number;
}): TourStepView {
  if (hasTarget) return "show";
  return waitedMs < waitForTargetMs ? "wait" : "skip";
}

export function WhatsNewTour({ onClose }: { onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [view, setView] = useState<TourStepView>("wait");
  const isMobile = useIsMobile();
  const step = STEPS[stepIndex];
  const isLast = stepIndex === STEPS.length - 1;

  const goToStep = useStableCallback((index: number) => {
    if (index >= STEPS.length) {
      onClose();
      return;
    }
    setView("wait");
    setStepIndex(index);
  });

  // Polled rather than observed: targets come and go as the list syncs,
  // virtualizes and re-renders, and a check every half second is plenty.
  useEffect(() => {
    const current = STEPS[stepIndex];
    const startedAt = Date.now();
    const check = () => {
      const next = getTourStepView({
        hasTarget: Boolean(current.findTarget()),
        waitedMs: Date.now() - startedAt,
        waitForTargetMs: current.waitForTargetMs,
      });
      if (next === "wait") return;
      clearInterval(interval);
      if (next === "skip") goToStep(stepIndex + 1);
      else setView("show");
    };
    const interval = setInterval(check, POLL_MS);
    check();
    return () => clearInterval(interval);
  }, [stepIndex, goToStep]);

  if (view === "wait" && !step.waitingMessage) return null;

  const isWaiting = view === "wait";
  const content = isWaiting ? (
    <>
      <p className="text-muted-foreground text-xs leading-5">
        {step.waitingMessage}
      </p>
      <div className="mt-3 flex justify-end">
        <Button size="xs-2" variant="ghost" onClick={onClose}>
          Skip tour
        </Button>
      </div>
    </>
  ) : (
    <>
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
          onClick={() => (isLast ? onClose() : goToStep(stepIndex + 1))}
        >
          {isLast ? "Done" : "Next"}
        </Button>
      </div>
    </>
  );
  const findTarget = isWaiting ? findList : step.findTarget;

  if (isMobile) {
    return (
      <PhoneTourCard key={`${stepIndex}-${view}`} findTarget={findTarget}>
        {content}
      </PhoneTourCard>
    );
  }

  return (
    <DesktopTourPopover
      key={`${stepIndex}-${view}`}
      findTarget={findTarget}
      onClose={onClose}
    >
      {content}
    </DesktopTourPopover>
  );
}

function DesktopTourPopover({
  findTarget,
  onClose,
  children,
}: {
  findTarget: () => Element | null;
  onClose: () => void;
  children: ReactNode;
}) {
  // Looked up on every measure rather than once, so the popover follows the
  // target as the list loads, scrolls and resizes. A tall target (the list)
  // only lends its top edge: a popover placed below it would land off screen.
  const anchorRef = useMemo(
    () => ({
      current: {
        getBoundingClientRect: () => {
          const rect = findTarget()?.getBoundingClientRect();
          if (!rect)
            return new DOMRect(window.innerWidth / 2, window.innerHeight / 3);
          return new DOMRect(
            rect.x,
            rect.y,
            rect.width,
            rect.height > 200 ? 40 : rect.height,
          );
        },
      },
    }),
    [findTarget],
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
        side="bottom"
        align="start"
        collisionPadding={16}
        aria-label="What's new in Cue"
        className="w-80"
        // Clicking around the mail shouldn't end the tour on the first step.
        onInteractOutside={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}

/**
 * On a phone a popover beside its target has no room and ends up on top of
 * it, so the step docks to whichever screen edge is farther from the target.
 */
function PhoneTourCard({
  findTarget,
  children,
}: {
  findTarget: () => Element | null;
  children: ReactNode;
}) {
  const [dock, setDock] = useState<"top" | "bottom">("bottom");

  useEffect(() => {
    const rect = findTarget()?.getBoundingClientRect();
    if (!rect) return;
    const targetCenter = rect.top + rect.height / 2;
    setDock(targetCenter > window.innerHeight / 2 ? "top" : "bottom");
  }, [findTarget]);

  return (
    <section
      aria-label="What's new in Cue"
      className={cn(
        "fixed inset-x-3 z-50 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-lg",
        dock === "top"
          ? "top-[max(0.75rem,env(safe-area-inset-top))]"
          : "bottom-[max(0.75rem,env(safe-area-inset-bottom))]",
      )}
    >
      {children}
    </section>
  );
}

function findList() {
  return document.querySelector(LIST_SELECTOR);
}
