import { NextResponse } from "next/server";
import { z } from "zod";
import {
  isCovered,
  MAX_CONFLICT_WINDOW_MS,
  rangesOverlap,
} from "@/utils/calendar/conflicts";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { isDeclinedByUser } from "@/utils/calendar/meeting-rules";
import { getUnifiedCalendarBusy } from "@/utils/calendar/unified-availability";
import type { Logger } from "@/utils/logger";
import { withEmailAccount } from "@/utils/middleware";

// A window this short holds a handful of events; more than this is a calendar
// we can't read in one go, and the answer is withheld.
const MAX_EVENTS_PER_CALENDAR = 50;

const querySchema = z
  .object({
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    uid: z.string().min(1).max(1000).optional(),
  })
  .transform(({ start, end, uid }) => ({
    start: new Date(start),
    end: new Date(end),
    uid,
  }))
  .refine(
    ({ start, end }) =>
      end > start && end.getTime() - start.getTime() <= MAX_CONFLICT_WINDOW_MS,
    { message: "end must be after start, at most 24 hours later" },
  );

export type GetCalendarConflictsResponse = Awaited<ReturnType<typeof getData>>;

// The invitation card's "Conflicts with …" line, read live: titles are shown
// once and never stored or cached.
export const GET = withEmailAccount(
  "user/calendar/conflicts",
  async (request) => {
    const { searchParams } = request.nextUrl;
    const query = querySchema.safeParse({
      start: searchParams.get("start") ?? undefined,
      end: searchParams.get("end") ?? undefined,
      uid: searchParams.get("uid") ?? undefined,
    });
    if (!query.success)
      return NextResponse.json(
        { error: "Invalid time range" },
        { status: 400 },
      );

    const result = await getData({
      ...query.data,
      emailAccountId: request.auth.emailAccountId,
      email: request.auth.email,
      logger: request.logger,
    });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" },
    });
  },
);

async function getData({
  emailAccountId,
  email,
  start,
  end,
  uid,
  logger,
}: {
  emailAccountId: string;
  email: string;
  start: Date;
  end: Date;
  uid?: string;
  logger: Logger;
}) {
  const invitation = { start, end };
  let busy: Awaited<ReturnType<typeof getUnifiedCalendarBusy>>;
  let calendar: Awaited<ReturnType<typeof fetchCalendarEventsInWindow>>;
  try {
    [busy, calendar] = await Promise.all([
      getUnifiedCalendarBusy({
        emailAccountId,
        range: invitation,
        logger,
        // A calendar we couldn't read could hide the conflict, and "You're
        // free" would then be wrong.
        failClosed: true,
        excludeGoogleVirtualCalendars: true,
      }),
      fetchCalendarEventsInWindow({
        emailAccountId,
        timeMin: start,
        timeMax: end,
        maxResultsPerProvider: MAX_EVENTS_PER_CALENDAR,
        logger,
      }),
    ]);
  } catch (error) {
    logger.warn("Could not read calendars for invitation conflicts", {
      error,
    });
    return { status: "unavailable" as const };
  }
  if (!busy.readableCalendars) return { status: "no-calendar" as const };
  if (!calendar.complete) return { status: "unavailable" as const };

  // What takes up the time: everything but events marked free or declined.
  // An all-day event the calendar returned for this window spans all of it.
  const blocking = calendar.events.filter(
    (event) =>
      !event.markedFree &&
      !isDeclinedByUser(event, ownAddresses(email, event.calendarEmail)) &&
      (event.allDay || rangesOverlap(eventRange(event), invitation)),
  );
  const isInvitation = (event: CalendarEvent) => !!uid && event.iCalUid === uid;
  const conflicts = blocking.filter((event) => !isInvitation(event));

  // Every busy moment must belong to an event we can name, or to the
  // invitation itself; busy time we can't explain makes "free" or a short
  // list a guess, so the card says nothing.
  const covers = blocking.map((event) =>
    event.allDay ? invitation : eventRange(event),
  );
  const unexplained = busy.busyPeriods.some((period) => {
    const clipped = {
      start: maxDate(new Date(period.start), start),
      end: minDate(new Date(period.end), end),
    };
    return clipped.start < clipped.end && !isCovered(clipped, covers);
  });
  logger.trace("Invitation conflicts", {
    conflictCount: conflicts.length,
    busyPeriodCount: busy.busyPeriods.length,
    unexplained,
  });
  if (unexplained) return { status: "unavailable" as const };

  return {
    status: "ok" as const,
    conflicts: conflicts.map((event) => ({
      // Providers name an untitled event "Untitled"; the card words it itself.
      title:
        event.title.trim() && event.title !== "Untitled" ? event.title : null,
      start: event.startTime.toISOString(),
      end: event.endTime.toISOString(),
    })),
  };
}

function eventRange(event: CalendarEvent) {
  return { start: event.startTime, end: event.endTime };
}

function maxDate(a: Date, b: Date) {
  return a > b ? a : b;
}

function minDate(a: Date, b: Date) {
  return a < b ? a : b;
}

function ownAddresses(email: string, calendarEmail: string | undefined) {
  return new Set(
    [email, calendarEmail]
      .filter((address): address is string => !!address)
      .map((address) => address.toLowerCase()),
  );
}
