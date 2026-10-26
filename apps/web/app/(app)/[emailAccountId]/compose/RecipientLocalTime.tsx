"use client";

import { useEffect, useState } from "react";
import { ClockIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { extractEmailAddresses } from "@/utils/email";
import { formatTheirTime, getRecipientLocalTime } from "./recipient-local-time";

const MINUTE_MS = 60_000;

/**
 * One quiet line with the recipient's hour, read from the offset their last
 * message was written in, and outside their day a way to send at their 8:00
 * through Send later.
 */
export function RecipientLocalTime({
  senderUtcOffsets,
  recipientHeaders,
  ownEmails,
  sendAt,
  onSendAt,
}: {
  senderUtcOffsets: Record<string, number | null> | undefined;
  recipientHeaders: string[];
  ownEmails: string[];
  sendAt: string;
  /** Unset when this composer can't schedule a send. */
  onSendAt?: (value: string) => void;
}) {
  const now = useMinuteClock();
  if (!senderUtcOffsets) return null;
  const own = new Set(ownEmails.map((email) => email.toLowerCase()));
  const recipients = [
    ...new Set(
      recipientHeaders
        .flatMap((header) => extractEmailAddresses(header))
        .map((address) => address.toLowerCase())
        .filter((address) => !own.has(address)),
    ),
  ];
  const theirs = getRecipientLocalTime({
    recipients,
    senderOffsets: senderUtcOffsets,
    ownOffsetMinutes: -now.getTimezoneOffset(),
    now,
  });
  if (!theirs) return null;
  const { offsetMinutes, outsideDay, nextMorning } = theirs;

  return (
    <div className="flex min-h-6 flex-wrap items-center gap-x-2 text-muted-foreground text-xs">
      <span
        className="inline-flex items-center gap-1 tabular-nums"
        title={`From the time zone of their last message (${formatUtcOffset(offsetMinutes)})`}
      >
        <ClockIcon aria-hidden className="size-3" />
        {formatTheirTime(now, offsetMinutes)} their time
      </span>
      {outsideDay && onSendAt && !sendAt && (
        <Button
          type="button"
          variant="ghostMuted"
          size="sm"
          className="h-6 px-1.5 text-xs underline-offset-2 hover:bg-transparent hover:underline"
          onClick={() => onSendAt(nextMorning.toISOString())}
        >
          Send at {formatTheirTime(nextMorning, offsetMinutes)} their time
        </Button>
      )}
    </div>
  );
}

function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    let interval: ReturnType<typeof setInterval> | undefined;
    // Ticks on the minute, so the line turns over with the user's clock.
    const timeout = setTimeout(
      () => {
        tick();
        interval = setInterval(tick, MINUTE_MS);
      },
      MINUTE_MS - (Date.now() % MINUTE_MS),
    );
    return () => {
      clearTimeout(timeout);
      clearInterval(interval);
    };
  }, []);
  return now;
}

function formatUtcOffset(offsetMinutes: number) {
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);
  const minutes = absolute % 60;
  return `UTC${sign}${Math.floor(absolute / 60)}${minutes ? `:${String(minutes).padStart(2, "0")}` : ""}`;
}
