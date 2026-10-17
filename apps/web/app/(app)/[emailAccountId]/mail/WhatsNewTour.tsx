"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { posthog } from "@/utils/analytics/posthog-client";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from "@/components/ui/popover";
import { useIsMobile } from "@/hooks/use-mobile";
import { useStableCallback } from "@/app/(app)/[emailAccountId]/mail/use-stable-callback";
import { cn } from "@/utils";
import {
  getCountBucket,
  ONBOARDING_ANALYTICS_EVENTS,
} from "@/utils/analytics/product";

/** The list, or its placeholder while the first sync is still running. */
const LIST_SELECTOR =
  '[role="listbox"][aria-label="Conversations"], [data-mail-list-placeholder]';
const INSIGHT_SELECTOR = '[data-testid="thread-insight"]';
const POLL_MS = 500;
/** Insights are written in the background; give up on them after a minute. */
export const INSIGHT_WAIT_MS = 60_000;

/** Cue's sorting fills Needs reply over the first minute after setup. */
const NEEDS_REPLY_WAIT_MS = 20_000;
const NEEDS_REPLY_TAB_NAME = "Needs reply";
const TOUR_LABEL = "Getting started";

type TourStepContent = { title: string; body: string; showTab?: boolean };

type TourStep = {
  getContent: (target: Element) => TourStepContent;
  findTarget: () => Element | null;
  /** How long the step waits for its target before it is skipped. */
  waitForTargetMs: number;
  /** Shown instead of skipping once the wait runs out, if it exists. */
  findFallbackTarget?: () => Element | null;
  /** Shown on the list while waiting, so the wait isn't silent. */
  waitingMessage?: string;
};

/** Each step appears only once the thing it points at is on screen. */
const STEPS: TourStep[] = [
  {
    getContent: () => ({
      title: "The line under each email",
      body: "What it asks of you, any deadline, and “Draft ready” when Cue has written your reply.",
    }),
    findTarget: () => document.querySelector(INSIGHT_SELECTOR),
    waitForTargetMs: INSIGHT_WAIT_MS,
    waitingMessage:
      "Cue is reading your recent mail. Notes appear under emails in about a minute.",
  },
  {
    getContent: () => ({
      title: "Open it for context and a reply",
      body: "Related mail, meetings and files, and a suggested reply when Cue can back every fact.",
    }),
    findTarget: () =>
      document.querySelector(INSIGHT_SELECTOR)?.closest('[role="option"]') ??
      null,
    waitForTargetMs: 0,
  },
  {
    // The payoff: how many emails are waiting on the person, from the count
    // the tab strip already loads. Without Cue's tabs there's no tab, so the
    // step is skipped.
    getContent: (target) =>
      getNeedsReplyStepCopy(
        Number(target.getAttribute("data-split-matching") ?? 0),
      ),
    findTarget: () => findNeedsReplyTab({ withReplies: true }),
    waitForTargetMs: NEEDS_REPLY_WAIT_MS,
    findFallbackTarget: () => findNeedsReplyTab({ withReplies: false }),
    waitingMessage: "Cue is finding what needs your reply…",
  },
];

export function getNeedsReplyStepCopy(count: number): TourStepContent {
  if (count <= 0) {
    return {
      title: "Needs reply fills in as Cue reads your mail.",
      body: "Mail waiting on your answer lands here, with a draft when Cue can write one.",
      showTab: false,
    };
  }
  return {
    title:
      count === 1
        ? "Cue found 1 email that needs your reply."
        : `Cue found ${count.toLocaleString("en-US")} emails that need your reply.`,
    body: "Start there; the ones marked Draft ready already have a reply waiting.",
    showTab: true,
  };
}

export function findNeedsReplyTab({ withReplies }: { withReplies: boolean }) {
  const tab = document.querySelector<HTMLElement>(
    `[data-split-tab][aria-label="${NEEDS_REPLY_TAB_NAME}"]`,
  );
  if (!tab) return null;
  if (!withReplies) return tab;
  return Number(tab.dataset.splitMatching ?? 0) > 0 ? tab : null;
}

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

export function WhatsNewTour({ onClose: closeTour }: { onClose: () => void }) {
  const [stepIndex, setStepIndex] = useState(0);
  const [view, setView] = useState<TourStepView>("wait");
  // Skipped steps leave the count, so a lone step reads "1 of 1".
  const [skippedSteps, setSkippedSteps] = useState<number[]>([]);
  const isMobile = useIsMobile();
  const step = STEPS[stepIndex];
  const availableSteps = STEPS.filter(
    (candidate, index) =>
      !skippedSteps.includes(index) && isStepAvailable(candidate),
  );
  const isLast = !STEPS.slice(stepIndex + 1).some(isStepAvailable);

  const trackStep = useStableCallback(
    (index: number, outcome: "shown" | "skipped" | "closed" | "show_me") => {
      const current = STEPS[index];
      const target = current?.findTarget() ?? current?.findFallbackTarget?.();
      const count = target?.getAttribute("data-split-matching");
      posthog?.capture(ONBOARDING_ANALYTICS_EVENTS.tourStep, {
        step: index + 1,
        outcome,
        ...(count == null
          ? {}
          : { needs_reply_count_bucket: getCountBucket(Number(count)) }),
      });
    },
  );
  const onClose = () => {
    trackStep(stepIndex, "closed");
    closeTour();
  };

  const goToStep = useStableCallback((index: number) => {
    if (index >= STEPS.length) {
      closeTour();
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
      if (next === "skip" && !current.findFallbackTarget?.()) {
        trackStep(stepIndex, "skipped");
        setSkippedSteps((current) => [...current, stepIndex]);
        goToStep(stepIndex + 1);
      } else {
        trackStep(stepIndex, "shown");
        setView("show");
      }
    };
    const interval = setInterval(check, POLL_MS);
    check();
    return () => clearInterval(interval);
  }, [stepIndex, goToStep, trackStep]);

  if (view === "wait" && !step.waitingMessage) return null;

  const isWaiting = view === "wait";
  const findStepTarget = () =>
    step.findTarget() ?? step.findFallbackTarget?.() ?? null;
  const target = isWaiting ? null : findStepTarget();
  const stepContent = target ? step.getContent(target) : null;
  const content =
    isWaiting || !stepContent ? (
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
          {availableSteps.indexOf(step) + 1} of {availableSteps.length}
        </p>
        <h3 className="mt-1 font-medium text-sm">{stepContent.title}</h3>
        <p className="mt-1 text-muted-foreground text-xs leading-5">
          {stepContent.body}
        </p>
        <div className="mt-3 flex items-center justify-end gap-2">
          {!isLast && (
            <Button size="xs-2" variant="ghost" onClick={onClose}>
              Skip tour
            </Button>
          )}
          {isLast && stepContent.showTab ? (
            <>
              <Button size="xs-2" variant="ghost" onClick={onClose}>
                Done
              </Button>
              <Button
                size="xs-2"
                onClick={() => {
                  trackStep(stepIndex, "show_me");
                  (findStepTarget() as HTMLElement | null)?.click();
                  closeTour();
                }}
              >
                Show me
              </Button>
            </>
          ) : (
            <Button
              size="xs-2"
              onClick={() => (isLast ? onClose() : goToStep(stepIndex + 1))}
            >
              {isLast ? "Done" : "Next"}
            </Button>
          )}
        </div>
      </>
    );
  const findTarget = isWaiting ? findList : findStepTarget;

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
        aria-label={TOUR_LABEL}
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
      aria-label={TOUR_LABEL}
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

/** A step that needs a target which can never appear is left out of the count. */
function isStepAvailable(step: TourStep) {
  if (!step.findFallbackTarget) return true;
  return Boolean(step.findTarget() ?? step.findFallbackTarget());
}
