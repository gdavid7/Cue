"use client";

import { useRef } from "react";
import { LoopPauseButton } from "@/app/(landing)/login/LoopPauseButton";
import {
  useLoopPlayback,
  useLoopSteps,
} from "@/app/(landing)/login/useLoopPlayback";
import { cn } from "@/utils";
import { BRAND_NAME } from "@/utils/branding";

// A made-up inbox in which Cue writes the next step under each email, one
// after another, then counts what needs a reply. Rendered in code from the
// same pieces as the real mail list, so it stays sharp and follows the theme.
const ROWS: {
  from: string;
  time: string;
  subject: string;
  nextStep: string;
  tone: keyof typeof TONE;
}[] = [
  {
    from: "Prof. Lin",
    time: "9:41",
    subject: "Milestone 2 check-in",
    nextStep: "Confirm meeting time · Oct 21 4 PM · CSE building",
    tone: "action",
  },
  {
    from: "Maya Chen",
    time: "9:12",
    subject: "Slides for Thursday?",
    nextStep: "Send your 3 slides · due Wed night",
    tone: "action",
  },
  {
    from: "Jordan Reyes",
    time: "8:30",
    subject: "Homepage edits, round 2",
    nextStep: "Draft ready · revised timeline for Friday",
    tone: "ready",
  },
  {
    from: "Campus Rec",
    time: "Yesterday",
    subject: "Fall intramurals sign-ups",
    nextStep: "Newsletter · nothing to do",
    tone: "info",
  },
];

const TONE = {
  ready: "text-emerald-700 dark:text-emerald-400",
  action: "text-primary",
  info: "text-muted-foreground",
};

// Placeholders, one next step per row, the counts, then the lines fade back
// to placeholders before starting over. The card itself never moves.
const PLACEHOLDER_STEP = 0;
const COUNTS_STEP = ROWS.length + 1;
const FADE_STEP = ROWS.length + 2;
const STEP_DURATIONS = [900, 750, 750, 750, 750, 5000, 450];

export function HeroInboxLoop() {
  const ref = useRef<HTMLDivElement>(null);
  const { playing, reducedMotion, paused, togglePaused } = useLoopPlayback(ref);
  // Starts on the finished picture, so the first paint (and anyone who
  // prefers reduced motion) sees every next step.
  const step = useLoopSteps(STEP_DURATIONS, playing, COUNTS_STEP);
  const revealed = step === PLACEHOLDER_STEP ? 0 : Math.min(step, ROWS.length);
  const clearing = step === FADE_STEP;
  const countsShown = step === COUNTS_STEP;

  return (
    <figure ref={ref} className="relative max-w-md">
      <figcaption className="sr-only">
        An example inbox. {BRAND_NAME} writes the next step under each email,
        for example “Confirm meeting time · Oct 21 4 PM · CSE building”, and
        counts the emails that need your reply.
      </figcaption>
      <div
        aria-hidden
        className="overflow-hidden rounded-xl border bg-card shadow-sm"
      >
        <div className="flex items-center gap-1.5 border-b px-3 py-2 text-xs">
          <Tab label="Needs reply" count={3} active countShown={countsShown} />
          <Tab label="Reading" count={1} countShown={countsShown} />
          <Tab label="All" />
        </div>
        <ul className="divide-y">
          {ROWS.map((row, index) => (
            <li key={row.from} className="px-3 py-2.5">
              <p className="flex items-baseline justify-between gap-3">
                <span className="truncate font-medium text-foreground text-sm">
                  {row.from}
                </span>
                <span className="shrink-0 text-muted-foreground text-xs">
                  {row.time}
                </span>
              </p>
              <p className="truncate text-muted-foreground text-sm">
                {row.subject}
              </p>
              <NextStepLine
                text={row.nextStep}
                tone={row.tone}
                state={
                  clearing ? "clearing" : index < revealed ? "shown" : "hidden"
                }
              />
            </li>
          ))}
        </ul>
      </div>
      {!reducedMotion && (
        <LoopPauseButton
          paused={paused}
          onToggle={togglePaused}
          className="absolute top-1 right-1"
        />
      )}
    </figure>
  );
}

// Written in left to right; cleared with a quieter fade.
const LINE_STYLE = {
  hidden: { clipPath: "inset(0 100% 0 0)", opacity: 1, transition: "none" },
  shown: {
    clipPath: "inset(0 0 0 0)",
    opacity: 1,
    transition: "clip-path 650ms cubic-bezier(0.2, 0, 0, 1)",
  },
  clearing: {
    clipPath: "inset(0 0 0 0)",
    opacity: 0,
    transition: "opacity 300ms ease-out",
  },
} as const;

function NextStepLine({
  text,
  tone,
  state,
}: {
  text: string;
  tone: keyof typeof TONE;
  state: keyof typeof LINE_STYLE;
}) {
  return (
    <span className="relative mt-1 block h-4">
      <span
        className={cn(
          "absolute inset-y-1 left-0 w-3/5 rounded-full bg-muted transition-opacity duration-300",
          state === "shown" ? "opacity-0" : "animate-pulse opacity-100",
        )}
      />
      <span
        className={cn(
          "absolute inset-0 flex min-w-0 items-center gap-1 text-xs",
          TONE[tone],
        )}
        style={LINE_STYLE[state]}
      >
        <span className="shrink-0">↳</span>
        <span className="truncate">{text}</span>
      </span>
    </span>
  );
}

function Tab({
  label,
  count,
  active = false,
  countShown = false,
}: {
  label: string;
  count?: number;
  active?: boolean;
  countShown?: boolean;
}) {
  return (
    <span
      className={cn(
        "flex items-center gap-1 rounded-full px-2.5 py-1",
        active
          ? "bg-primary/10 font-medium text-primary"
          : "text-muted-foreground",
      )}
    >
      {label}
      {count !== undefined && (
        <span
          className={cn(
            "tabular-nums transition-opacity duration-300",
            countShown ? "opacity-100" : "opacity-0",
          )}
        >
          {count}
        </span>
      )}
    </span>
  );
}
