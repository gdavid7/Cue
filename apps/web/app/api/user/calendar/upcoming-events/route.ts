import { TZDate } from "@date-fns/tz";
import { addDays, startOfDay } from "date-fns";
import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { countConnectedCalendars } from "@/utils/calendar/connections";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { Logger } from "@/utils/logger";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";

// Today's "Your day" strip stays a glance, not a calendar view.
const TODAY_EVENTS_SHOWN = 8;
// Past the strip's cap, so a busy day can still say how many it left out.
const TODAY_EVENTS_PER_CALENDAR = 25;

export type GetCalendarUpcomingEventsResponse = Awaited<
  ReturnType<typeof getData>
>;
export type GetCalendarTodayEventsResponse = Awaited<
  ReturnType<typeof getTodayData>
>;

export const GET = withEmailAccount(
  "user/calendar/upcoming-events",
  async (request) => {
    const { emailAccountId, userId, email } = request.auth;
    const { searchParams } = request.nextUrl;

    if (searchParams.get("range") === "today") {
      return NextResponse.json(
        await getTodayData({
          emailAccountId,
          userId,
          email,
          // "Today" is the browser's, which the server can't see.
          timeZone: validTimeZone(searchParams.get("tz")) ?? "UTC",
          logger: request.logger,
        }),
      );
    }

    const result = await getData({
      emailAccountId,
      logger: request.logger,
    });
    return NextResponse.json(result);
  },
);

async function getData({
  emailAccountId,
  logger,
}: {
  emailAccountId: string;
  logger: Logger;
}) {
  const providers = await createCalendarEventProviders(emailAccountId, logger);

  const providerEvents = await Promise.all(
    providers.map(async (provider) => provider.fetchEvents({ maxResults: 3 })),
  );

  return {
    events: providerEvents
      .flat()
      .sort((a, b) => a.startTime.getTime() - b.startTime.getTime()),
  };
}

/**
 * The meetings on the user's local day, from every calendar they connected
 * on any account, with the other people on each. Read for this response
 * only: nothing about the events is kept or logged beyond counts.
 */
async function getTodayData({
  emailAccountId,
  userId,
  email,
  timeZone,
  logger,
}: {
  emailAccountId: string;
  userId: string;
  email: string;
  timeZone: string;
  logger: Logger;
}) {
  const now = new Date();
  const dayStart = startOfDay(new TZDate(now, timeZone));
  const dayEnd = addDays(dayStart, 1);
  const [calendar, addresses, calendarAccounts] = await Promise.all([
    fetchCalendarEventsInWindow({
      emailAccountId,
      timeMin: dayStart,
      timeMax: dayEnd,
      maxResultsPerProvider: TODAY_EVENTS_PER_CALENDAR,
      logger,
    }),
    getUserOwnAddresses(userId).catch((error) => {
      logger.warn("Failed to load own addresses for today's events", {
        error,
      });
      return [];
    }),
    countConnectedCalendars(emailAccountId),
  ]);
  const own = new Set([email, ...addresses].map((a) => a.toLowerCase()));
  const isSelf = (event: CalendarEvent, address: string) =>
    own.has(address.toLowerCase()) ||
    address.toLowerCase() === event.calendarEmail?.toLowerCase();

  // All-day entries such as holidays don't fill a day, and a meeting the user
  // declined on any of their addresses isn't on it.
  const meetings = calendar.events.filter(
    (event) =>
      !event.allDay &&
      !event.attendees.some(
        (attendee) => attendee.declined && isSelf(event, attendee.email),
      ),
  );
  const shown = keepComingMeetings(meetings, now);
  // With two calendar accounts, each meeting says whose calendar it's on.
  const labelCalendars = calendarAccounts > 1;

  return {
    connected: !calendar.noCalendarConnected,
    events: shown.map((event) => ({
      id: event.id,
      title: event.title,
      startTime: event.startTime.toISOString(),
      endTime: event.endTime.toISOString(),
      ...(event.eventUrl ? { eventUrl: event.eventUrl } : {}),
      ...(labelCalendars && event.calendarEmail
        ? { calendarEmail: event.calendarEmail }
        : {}),
      attendees: event.attendees
        .filter(
          (attendee) =>
            !attendee.declined &&
            !isSelf(event, attendee.email) &&
            !isRoom(attendee.email),
        )
        .map((attendee) => ({
          email: attendee.email,
          ...(attendee.name ? { name: attendee.name } : {}),
        })),
    })),
    more: meetings.length - shown.length,
  };
}

/**
 * At most `TODAY_EVENTS_SHOWN`, in order. On a fuller day the meetings
 * already over give way first, so what's still to come always shows.
 */
function keepComingMeetings(meetings: CalendarEvent[], now: Date) {
  let excess = meetings.length - TODAY_EVENTS_SHOWN;
  const kept = meetings.filter((event) => {
    if (excess > 0 && event.endTime <= now) {
      excess--;
      return false;
    }
    return true;
  });
  return kept.slice(0, TODAY_EVENTS_SHOWN);
}

// Rooms and equipment are booked as attendees; they aren't people to meet.
function isRoom(address: string) {
  return address.toLowerCase().endsWith("@resource.calendar.google.com");
}

function validTimeZone(value: string | null) {
  if (!value) return;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return value;
  } catch {
    return;
  }
}
