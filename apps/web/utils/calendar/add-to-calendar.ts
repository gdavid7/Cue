import { BookingLinkLocationType } from "@/generated/prisma/enums";
import { createCalendarEvent } from "@/utils/calendar/event-writer";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const HAS_UTC_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const DEFAULT_DURATION_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Puts an item on the user's own calendar (the primary calendar Cue writes
 * to), for chat and the reader's button alike. Never invites anyone.
 */
export async function addToCalendar({
  emailAccountId,
  title,
  start,
  end,
  location,
  timezone,
  logger,
}: {
  emailAccountId: string;
  title: string;
  start: string;
  end?: string | null;
  location?: string | null;
  timezone: string;
  logger: Logger;
}) {
  const times = resolveEventTimes({ start, end });

  const created = await createCalendarEvent({
    emailAccountId,
    title,
    ...times,
    timezone,
    attendees: [],
    locationType: BookingLinkLocationType.CUSTOM,
    locationValue: location || null,
    logger,
  });

  return {
    title,
    allDay: times.allDay,
    start: times.allDay ? start : times.startTime.toISOString(),
    end: times.allDay
      ? formatDate(new Date(times.endTime.getTime() - DAY_MS))
      : times.endTime.toISOString(),
    eventUrl: created.eventUrl ?? null,
  };
}

/**
 * A date (YYYY-MM-DD) is an all-day item through `end`'s date, inclusive. A
 * date-time must carry its UTC offset, since a bare clock time could be in any
 * zone, and lasts an hour unless `end` says otherwise.
 */
export function resolveEventTimes({
  start,
  end,
}: {
  start: string;
  end?: string | null;
}): { allDay: boolean; startTime: Date; endTime: Date } {
  if (DATE_ONLY.test(start)) {
    if (end && !DATE_ONLY.test(end)) {
      throw new SafeError(
        "An all-day item's end must also be a date (YYYY-MM-DD).",
      );
    }
    const startTime = parseDate(start);
    const lastDay = end ? parseDate(end) : startTime;
    if (lastDay < startTime) {
      throw new SafeError("The end date is before the start date.");
    }
    return {
      allDay: true,
      startTime,
      endTime: new Date(lastDay.getTime() + DAY_MS),
    };
  }

  const startTime = parseDateTime(start);
  const endTime = end
    ? parseDateTime(end)
    : new Date(startTime.getTime() + DEFAULT_DURATION_MS);
  if (endTime <= startTime) {
    throw new SafeError("The end time must be after the start time.");
  }
  return { allDay: false, startTime, endTime };
}

function parseDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  // Rejects dates that roll over, e.g. February 30.
  if (Number.isNaN(date.getTime()) || formatDate(date) !== value) {
    throw new SafeError(`"${value}" is not a valid date.`);
  }
  return date;
}

function parseDateTime(value: string) {
  if (!HAS_UTC_OFFSET.test(value)) {
    throw new SafeError(
      `"${value}" needs a UTC offset, e.g. 2026-10-20T14:00:00-07:00.`,
    );
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new SafeError(`"${value}" is not a valid date and time.`);
  }
  return date;
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}
