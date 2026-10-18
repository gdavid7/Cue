import { createCalendarEventProvider } from "@/utils/calendar/event-provider";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import type { Logger } from "@/utils/logger";
import { getProviderAlignedLocationType } from "@/utils/booking/location";
import type { BookingLinkLocationType } from "@/generated/prisma/enums";
import type {
  CalendarEventAttendee,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";

export type CreateCalendarEventInput = {
  allDay?: boolean;
  attendees: CalendarEventAttendee[];
  description?: string;
  destinationCalendarId?: string | null;
  emailAccountId: string;
  endTime: Date;
  locationType: BookingLinkLocationType;
  locationValue?: string | null;
  startTime: Date;
  timezone: string;
  title: string;
};

export type CreatedCalendarEvent = CalendarEventWriteResult & {
  /**
   * The calendar login the event went to. Without an explicit destination it
   * can be a calendar connected from another of the person's mailboxes, so
   * callers say where the event landed.
   */
  calendarAccountEmail: string;
  provider: string;
  providerConnectionId: string;
};

export async function createCalendarEvent({
  allDay,
  emailAccountId,
  destinationCalendarId,
  title,
  description,
  startTime,
  endTime,
  timezone,
  attendees,
  locationType,
  locationValue,
  logger,
}: CreateCalendarEventInput & {
  logger: Logger;
}): Promise<CreatedCalendarEvent> {
  const destination = await getWritableCalendar({
    emailAccountId,
    destinationCalendarId,
  });
  const provider = createCalendarEventProvider({
    connection: destination.connection,
    emailAccountId: destination.connection.emailAccountId,
    logger,
  });

  const createdEvent = await provider.createEvent({
    allDay,
    calendarId: destination.calendarId,
    title,
    description,
    startTime,
    endTime,
    timezone,
    attendees,
    locationType: getProviderAlignedLocationType({
      locationType,
      provider: destination.connection.provider,
    }),
    locationValue,
  });

  return {
    ...createdEvent,
    calendarAccountEmail: destination.connection.email,
    provider: destination.connection.provider,
    providerConnectionId: destination.connection.id,
  };
}

export async function updateCalendarEvent({
  providerConnectionId,
  providerCalendarId,
  providerEventId,
  emailAccountId,
  startTime,
  endTime,
  timezone,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  providerEventId: string;
  emailAccountId: string;
  startTime: Date;
  endTime: Date;
  timezone: string;
  logger: Logger;
}) {
  const writableProvider = await getWritableProviderForExistingEvent({
    providerConnectionId,
    providerCalendarId,
    emailAccountId,
    logger,
  });

  await writableProvider.updateEvent({
    calendarId: providerCalendarId,
    eventId: providerEventId,
    startTime,
    endTime,
    timezone,
  });
}

export async function cancelCalendarEvent({
  providerConnectionId,
  providerCalendarId,
  providerEventId,
  emailAccountId,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  providerEventId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  const writableProvider = await getWritableProviderForExistingEvent({
    providerConnectionId,
    providerCalendarId,
    emailAccountId,
    logger,
  });

  await writableProvider.cancelEvent({
    calendarId: providerCalendarId,
    eventId: providerEventId,
  });
}

async function getWritableProviderForExistingEvent({
  providerConnectionId,
  providerCalendarId,
  emailAccountId,
  logger,
}: {
  providerConnectionId: string;
  providerCalendarId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  // Look up by connection id (unique) instead of (emailAccountId, provider)
  // — a host can have multiple connections of the same provider, and
  // calendarIds like "primary" recur across them.
  const connection = await prisma.calendarConnection.findFirst({
    where: {
      id: providerConnectionId,
      ...calendarConnectionsWhere(emailAccountId),
      isConnected: true,
    },
    select: {
      id: true,
      emailAccountId: true,
      provider: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      calendars: {
        where: { calendarId: providerCalendarId },
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!connection) {
    throw new SafeError("Calendar connection not found");
  }
  if (connection.calendars.length === 0) {
    throw new SafeError("Destination calendar not found");
  }

  return createCalendarEventProvider({
    connection,
    emailAccountId: connection.emailAccountId,
    logger,
  });
}

async function getWritableCalendar({
  emailAccountId,
  destinationCalendarId,
}: {
  emailAccountId: string;
  destinationCalendarId?: string | null;
}) {
  // Without an explicit destination, prefer the primary calendar (via
  // orderBy) but accept any enabled calendar — accounts synced before
  // Microsoft primary tracking have no primary row. The mailbox's own
  // calendars come first, then the rest of the person's.
  const where = destinationCalendarId ? { id: destinationCalendarId } : {};
  const scopes = destinationCalendarId
    ? [calendarConnectionsWhere(emailAccountId)]
    : [
        calendarConnectionsWhere(emailAccountId, { ownConnectionsOnly: true }),
        calendarConnectionsWhere(emailAccountId),
      ];

  for (const scope of scopes) {
    // Availability scans only consider enabled calendars, so writing to a
    // disabled one would silently bypass conflict detection.
    const calendar = await prisma.calendar.findFirst({
      where: {
        ...where,
        isEnabled: true,
        connection: { ...scope, isConnected: true },
      },
      orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
      select: {
        calendarId: true,
        connection: {
          select: {
            id: true,
            emailAccountId: true,
            email: true,
            provider: true,
            accessToken: true,
            refreshToken: true,
            expiresAt: true,
          },
        },
      },
    });
    if (calendar) return calendar;
  }

  throw new SafeError("Destination calendar not found");
}
