"use client";

import Link from "next/link";
import { useId } from "react";
import { CheckIcon, ChevronRightIcon } from "lucide-react";
import { useMailHref } from "@/hooks/useMailHref";
import { cn } from "@/utils";
import type { TodayData } from "@/utils/home/merge-home";
import { ConnectLine } from "./NextUp";
import { TodayStatus } from "./TodayStatus";
import { formatDay, formatFromNow, formatTime } from "./today-format";

/**
 * Nothing needs a reply: say so once, prove Cue looked, and say what's next.
 * Every line under the proof shows only when there's something to say.
 */
export function AllClear({
  data,
  emailAccountId,
  now,
  waitingOn,
  waitingShown,
  onToggleWaiting,
  children,
}: {
  data: TodayData;
  emailAccountId: string;
  now: Date;
  /** How many people the user is waiting on. */
  waitingOn: number;
  /** Whether the waiting-on conversations are expanded under the line. */
  waitingShown: boolean;
  onToggleWaiting: () => void;
  /** The waiting-on conversations. */
  children: React.ReactNode;
}) {
  const { today, calendar, suggestion } = data;
  const titleId = useId();
  const waitingId = useId();
  const next = calendar.next;
  const deadline = data.nextUp.find((item) => item.kind === "deadline");

  return (
    <section aria-labelledby={titleId} className="space-y-3">
      <TodayStatus
        icon={CheckIcon}
        title="All clear."
        titleId={titleId}
        tone="done"
      >
        Nothing needs a reply.{" "}
        {today.checked ? <CueChecked today={today} /> : "Nothing new today."}
      </TodayStatus>

      <div className="space-y-1.5 text-sm">
        {next ? (
          <p className="text-foreground">
            {next.tomorrow ? (
              <>
                Tomorrow starts with <EventName event={next} /> at{" "}
                <span className="whitespace-nowrap">
                  {formatTime(next.at)}.
                </span>
              </>
            ) : (
              <>
                Next: <EventName event={next} /> at{" "}
                <span className="whitespace-nowrap">
                  {formatTime(next.at)} ·
                </span>{" "}
                <span className="whitespace-nowrap text-muted-foreground">
                  {formatFromNow(next.at, now)}
                </span>
              </>
            )}
          </p>
        ) : null}
        {calendar.connected ? null : (
          <ConnectLine
            emailAccountId={emailAccountId}
            name="Calendar"
            path="/calendars"
            purpose="to see what's next."
          />
        )}
        {deadline ? (
          <p className="text-foreground">
            Due {formatDay(deadline.at, now)}:{" "}
            {deadline.url ? (
              <ExternalLink href={deadline.url}>{deadline.title}</ExternalLink>
            ) : (
              deadline.title
            )}{" "}
            <span className="text-muted-foreground">({deadline.source})</span>
          </p>
        ) : null}
        {suggestion ? (
          <ConnectLine
            emailAccountId={emailAccountId}
            name={suggestion.name}
            path="/integrations"
            purpose="to see what's due."
          />
        ) : null}
        {waitingOn ? (
          <button
            aria-controls={waitingShown ? waitingId : undefined}
            aria-expanded={waitingShown}
            className="-mx-1 flex items-center gap-1 rounded px-1 text-foreground hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
            onClick={onToggleWaiting}
            type="button"
          >
            Waiting on {plural(waitingOn, "person", "people")}
            <ChevronRightIcon
              aria-hidden
              className={cn(
                "size-4 text-muted-foreground motion-safe:transition-transform",
                waitingShown && "rotate-90",
              )}
            />
          </button>
        ) : null}
      </div>
      {waitingOn && waitingShown ? <div id={waitingId}>{children}</div> : null}
    </section>
  );
}

/**
 * "Cue checked 42 emails today and filed 12.", the proof Cue looked. Filed
 * mail links to where it went, when that's one label.
 */
export function CueChecked({ today }: { today: TodayData["today"] }) {
  const mailHref = useMailHref();
  const filed = today.filedLabel ? (
    <Link
      className="text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current"
      href={mailHref({
        // Across accounts, the label is in the one account that filed today.
        accountId: today.filedLabel.accountId,
        view: { kind: "label", slug: today.filedLabel.labelId },
      })}
    >
      filed {today.filed}
    </Link>
  ) : (
    `filed ${today.filed}`
  );
  return (
    <>
      Cue checked {plural(today.checked, "email")} today
      {today.filed ? <> and {filed}</> : null}.
    </>
  );
}

function EventName({ event }: { event: { title: string; url?: string } }) {
  return event.url ? (
    <ExternalLink className="font-medium" href={event.url}>
      {event.title}
    </ExternalLink>
  ) : (
    <span className="font-medium">{event.title}</span>
  );
}

/** A link out to where an item lives, which opens in a new tab and says so. */
function ExternalLink({
  href,
  className,
  children,
}: {
  href: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <a
      className={cn(
        "underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-current",
        className,
      )}
      href={href}
      rel="noreferrer"
      target="_blank"
    >
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function plural(count: number, one: string, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}
