"use client";

import { useEffect, useRef, useState } from "react";
import { SparklesIcon } from "lucide-react";
import { ConnectorLogo } from "@/components/connectors/ConnectorLogo";
import { LoopPauseButton } from "@/app/(landing)/login/LoopPauseButton";
import { useLoopPlayback } from "@/app/(landing)/login/useLoopPlayback";
import { cn } from "@/utils";
import { BRAND_NAME } from "@/utils/branding";

// A made-up inbox that shows what Cue adds to each email: a next-step line,
// a related calendar event and a suggested reply.
const DEMO_EMAILS: {
  id: string;
  from: string;
  subject: string;
  nextStep: string[];
  event: { title: string; meta: string };
  reply: string;
}[] = [
  {
    id: "class",
    from: "Prof. Lin",
    subject: "Milestone 2 check-in",
    nextStep: [
      "Confirm meeting time for milestone 2",
      "Oct 21 4 PM",
      "CSE building",
    ],
    event: { title: "Milestone 2 check-in", meta: "Tue Oct 21 · 4 PM" },
    reply:
      "Hi Professor Lin, Tuesday Oct 21 at 4 PM works for our team. We'll see you in the CSE building. Thanks!",
  },
  {
    id: "client",
    from: "Jordan Reyes",
    subject: "Homepage edits, round 2",
    nextStep: ["Send a revised timeline", "edits due Fri"],
    event: { title: "Homepage edits, round 2", meta: "Fri · due" },
    reply:
      "Hi Jordan, thanks for the notes. I can have round 2 to you by Friday and will send an updated timeline tomorrow.",
  },
  {
    id: "team",
    from: "Sam Patel",
    subject: "Is ENG-412 still blocked?",
    nextStep: ["Answer Sam about ENG-412", "blocks Thursday's release"],
    event: { title: "Release sync", meta: "Thu · 9 AM" },
    reply:
      "Hi Sam, not blocked anymore. The fix is in review and should merge today, so Thursday's release is on track.",
  },
];

export function IntelligenceDemo() {
  const ref = useRef<HTMLElement>(null);
  const { playing, reducedMotion, paused, togglePaused } = useLoopPlayback(ref);
  const [selectedId, setSelectedId] = useState(DEMO_EMAILS[0].id);
  // Steps through the emails on its own until the viewer picks one.
  const [autoplay, setAutoplay] = useState(true);
  // Replays the context arriving the first time the demo comes into view.
  const [cycle, setCycle] = useState(0);
  const selectedIndex = Math.max(
    0,
    DEMO_EMAILS.findIndex((email) => email.id === selectedId),
  );
  const selected = DEMO_EMAILS[selectedIndex];
  const showProgress = autoplay && !reducedMotion;

  useEffect(() => {
    if (playing) setCycle((current) => current || 1);
  }, [playing]);

  const advance = () => {
    setSelectedId(DEMO_EMAILS[(selectedIndex + 1) % DEMO_EMAILS.length].id);
    setCycle((current) => current + 1);
  };

  return (
    <figure
      ref={ref}
      className="overflow-hidden rounded-xl border bg-card shadow-sm"
    >
      <div className="grid md:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <div
          role="group"
          aria-label="Example inbox"
          className="divide-y border-b md:border-r md:border-b-0"
        >
          {DEMO_EMAILS.map((email) => {
            const isSelected = email.id === selected.id;
            return (
              <button
                key={email.id}
                type="button"
                aria-pressed={isSelected}
                onClick={() => {
                  setAutoplay(false);
                  setSelectedId(email.id);
                  setCycle((current) => current + 1);
                }}
                className={cn(
                  "relative block w-full px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isSelected ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span className="block truncate font-medium text-foreground text-sm">
                  {email.from}
                </span>
                <span className="block truncate text-foreground/80 text-sm">
                  {email.subject}
                </span>
                <span className="mt-1 flex min-w-0 items-start gap-1 text-primary text-xs">
                  <span aria-hidden className="shrink-0">
                    ↳
                  </span>
                  <span>{email.nextStep.join(" · ")}</span>
                </span>
                {isSelected && showProgress && (
                  <span
                    aria-hidden
                    key={cycle}
                    className="absolute inset-x-0 bottom-0 h-0.5 origin-left animate-loop-progress bg-primary/50"
                    style={{
                      animationPlayState: playing ? "running" : "paused",
                    }}
                    onAnimationEnd={advance}
                  />
                )}
              </button>
            );
          })}
        </div>

        <div
          key={`${selected.id}-${cycle}`}
          className="space-y-4 p-4"
          aria-live={autoplay ? "off" : "polite"}
        >
          <div>
            <p className="font-medium text-muted-foreground text-xs">
              On your calendar
            </p>
            <div className="mt-2 flex items-center gap-3 rounded-lg border bg-background px-3 py-2 motion-safe:animate-hero-rise">
              <ConnectorLogo domain="google.com" size={20} />
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground text-sm">
                  {selected.event.title}
                </span>
                <span className="block truncate text-muted-foreground text-xs">
                  Google Calendar · {selected.event.meta}
                </span>
              </span>
            </div>
          </div>
          <div>
            <p className="flex items-center gap-1.5 font-medium text-muted-foreground text-xs">
              <SparklesIcon className="size-3.5" aria-hidden />
              Suggested reply · learns from your edits
            </p>
            <p className="mt-2 rounded-lg border bg-background px-3 py-2 text-foreground text-sm leading-relaxed">
              {selected.reply.split(" ").map((word, index) => (
                <span
                  key={index}
                  className="motion-safe:animate-hero-rise"
                  style={{ animationDelay: `${500 + index * 35}ms` }}
                >
                  {word}{" "}
                </span>
              ))}
            </p>
          </div>
        </div>
      </div>
      <figcaption className="flex items-center justify-between gap-3 border-t px-4 py-2 text-muted-foreground text-xs">
        <span>
          An example. Pick an email to see what {BRAND_NAME} shows next to it.
          Names and messages are made up.
        </span>
        {showProgress && (
          <LoopPauseButton
            paused={paused}
            onToggle={togglePaused}
            className="-my-1 shrink-0"
          />
        )}
      </figcaption>
    </figure>
  );
}
