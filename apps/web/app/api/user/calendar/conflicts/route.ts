import { NextResponse } from "next/server";
import { z } from "zod";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import {
  MAX_CONFLICT_WINDOW_MS,
  rangesOverlap,
} from "@/utils/calendar/conflicts";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { isDeclinedByUser } from "@/utils/calendar/meeting-rules";
import { isGoogleVirtualCalendarId } from "@/utils/calendar/providers/google-calendar-id";
import { getUnifiedCalendarAvailability } from "@/utils/calendar/unified-availability";
import { isGoogleProvider } from "@/utils/email/provider-types";
import type { Logger } from "@/utils/logger";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

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
  const enabledCalendars = await prisma.calendar.findMany({
    where: {
      isEnabled: true,
      connection: {
        ...calendarConnectionsWhere(emailAccountId),
        isConnected: true,
      },
    },
    select: { calendarId: true, connection: { select: { provider: true } } },
  });
  // Holidays and birthdays aren't read for availability, so they can't make
  // the person busy.
  const hasReadableCalendar = enabledCalendars.some(
    (calendar) =>
      !(
        isGoogleProvider(calendar.connection.provider) &&
        isGoogleVirtualCalendarId(calendar.calendarId)
      ),
  );
  if (!hasReadableCalendar) return { status: "no-calendar" as const };

  const invitation = { start, end };
  let busy: Awaited<ReturnType<typeof getUnifiedCalendarAvailability>>;
  let calendar: Awaited<ReturnType<typeof fetchCalendarEventsInWindow>>;
  try {
    [busy, calendar] = await Promise.all([
      getUnifiedCalendarAvailability({
        emailAccountId,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
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

  // Busy time is what the calendars themselves count: events marked free,
  // declined or cancelled don't block it.
  const busyInWindow = busy
    .map((period) => ({
      start: new Date(period.start),
      end: new Date(period.end),
    }))
    .filter((period) => rangesOverlap(period, invitation));
  if (!busyInWindow.length) return { status: "ok" as const, conflicts: [] };
  // Busy, but some events weren't read: the busy block may be one of them.
  if (!calendar.complete) return { status: "unavailable" as const };

  const conflicts = calendar.events.filter((event) => {
    const range = { start: event.startTime, end: event.endTime };
    return (
      !event.allDay &&
      // The invitation itself, already on the calendar.
      !(uid && event.iCalUid === uid) &&
      rangesOverlap(range, invitation) &&
      busyInWindow.some((period) => rangesOverlap(period, range)) &&
      !isDeclinedByUser(event, ownAddresses(email, event.calendarEmail))
    );
  });
  logger.trace("Invitation conflicts", {
    conflictCount: conflicts.length,
    busyPeriodCount: busyInWindow.length,
  });

  return {
    status: "ok" as const,
    conflicts: conflicts.map((event) => ({
      title: event.title,
      start: event.startTime.toISOString(),
      end: event.endTime.toISOString(),
    })),
  };
}

function ownAddresses(email: string, calendarEmail: string | undefined) {
  return new Set(
    [email, calendarEmail]
      .filter((address): address is string => !!address)
      .map((address) => address.toLowerCase()),
  );
}
