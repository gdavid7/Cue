import { TZDate } from "@date-fns/tz";
import { startOfDay, endOfDay, format } from "date-fns";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { BusyPeriod } from "./availability-types";
import { getCalendarAvailabilityErrorLogContext } from "./availability-error";
import { createGoogleAvailabilityProvider } from "./providers/google-availability";
import { createMicrosoftAvailabilityProvider } from "./providers/microsoft-availability";
import { isGoogleVirtualCalendarId } from "./providers/google-calendar-id";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import { onePerExternalAccount } from "@/utils/user/owned-by-same-user";

/**
 * Fetch calendar availability across all connected calendars (Google and Microsoft)
 */
export async function getUnifiedCalendarAvailability({
  emailAccountId,
  startDate,
  endDate,
  timezone = "UTC",
  logger,
  failClosed = false,
  excludeGoogleVirtualCalendars = false,
}: {
  emailAccountId: string;
  startDate: Date | string;
  endDate: Date | string;
  timezone?: string;
  logger: Logger;
  /**
   * Throw instead of skipping a calendar that cannot be read: for every
   * connection, or only those the predicate picks (say, the one a booking is
   * written to), while the others are skipped and logged.
   */
  failClosed?:
    | boolean
    | ((connection: { id: string; emailAccountId: string }) => boolean);
  excludeGoogleVirtualCalendars?: boolean;
}): Promise<BusyPeriod[]> {
  // Compute day boundaries in the user's timezone
  // Parse dates as calendar dates in the target timezone to avoid UTC shift issues
  const startDateInTZ = parseDateInTimezone(startDate, timezone);
  const endDateInTZ = parseDateInTimezone(endDate, timezone);

  const timeMin = startOfDay(startDateInTZ).toISOString();
  const timeMax = endOfDay(endDateInTZ).toISOString();

  logger.trace("Unified calendar availability request", {
    timezone,
    emailAccountId,
    startDate: startDate instanceof Date ? startDate.toISOString() : startDate,
    endDate: endDate instanceof Date ? endDate.toISOString() : endDate,
    timeMin,
    timeMax,
  });

  // Busy on any of the person's calendars is busy, whichever mailbox asks.
  const calendarConnections = onePerExternalAccount(
    await prisma.calendarConnection.findMany({
      where: {
        ...calendarConnectionsWhere(emailAccountId),
        isConnected: true,
      },
      include: {
        calendars: {
          where: { isEnabled: true },
          select: {
            calendarId: true,
          },
        },
      },
    }),
  );

  if (!calendarConnections.length) {
    logger.info("No calendar connections found", { emailAccountId });
    return [];
  }

  // Group calendars by provider
  const googleConnections = calendarConnections.filter((conn) =>
    isGoogleProvider(conn.provider),
  );
  const microsoftConnections = calendarConnections.filter(
    (conn) => conn.provider === "microsoft",
  );

  const promises: Promise<BusyPeriod[]>[] = [];

  // Fetch Google calendar availability
  for (const connection of googleConnections) {
    const calendarIds = connection.calendars.map((cal) => cal.calendarId);
    const availabilityCalendarIds = excludeGoogleVirtualCalendars
      ? calendarIds.filter(
          (calendarId) => !isGoogleVirtualCalendarId(calendarId),
        )
      : calendarIds;
    if (!availabilityCalendarIds.length) continue;

    const googleAvailabilityProvider = createGoogleAvailabilityProvider(logger);
    const mustRead = mustReadConnection(failClosed, connection);

    promises.push(
      googleAvailabilityProvider
        .fetchBusyPeriods({
          accessToken: connection.accessToken,
          connectionId: connection.id,
          refreshToken: connection.refreshToken,
          expiresAt: connection.expiresAt?.getTime() || null,
          emailAccountId: connection.emailAccountId,
          calendarIds: availabilityCalendarIds,
          timeMin,
          timeMax,
          failOnCalendarError: mustRead,
        })
        .catch((error) => {
          logger.error("Error fetching Google calendar availability", {
            error,
            connectionId: connection.id,
            ...getCalendarAvailabilityErrorLogContext(error),
          });
          if (mustRead) throw error;
          return [];
        }),
    );
  }

  // Fetch Microsoft calendar availability
  for (const connection of microsoftConnections) {
    const calendarIds = connection.calendars.map((cal) => cal.calendarId);

    if (!calendarIds.length) {
      logger.warn("No enabled calendars for Microsoft connection", {
        connectionId: connection.id,
      });
      continue;
    }

    const microsoftAvailabilityProvider =
      createMicrosoftAvailabilityProvider(logger);
    const mustRead = mustReadConnection(failClosed, connection);

    promises.push(
      microsoftAvailabilityProvider
        .fetchBusyPeriods({
          accessToken: connection.accessToken,
          connectionId: connection.id,
          refreshToken: connection.refreshToken,
          expiresAt: connection.expiresAt?.getTime() || null,
          emailAccountId: connection.emailAccountId,
          calendarIds,
          timeMin,
          timeMax,
          failOnCalendarError: mustRead,
        })
        .catch((error) => {
          logger.error("Error fetching Microsoft calendar availability", {
            error,
            connectionId: connection.id,
            ...getCalendarAvailabilityErrorLogContext(error),
          });
          if (mustRead) throw error;
          return [];
        }),
    );
  }

  // Wait for all providers to return results
  const results = await Promise.all(promises);

  // Flatten and merge all busy periods
  const allBusyPeriods = results.flat();

  // Convert all busy periods from UTC to user timezone
  const convertedBusyPeriods = convertBusyPeriodsToTimezone(
    allBusyPeriods,
    timezone,
  );

  logger.trace("Unified calendar availability results", {
    totalBusyPeriods: convertedBusyPeriods.length,
    googleConnectionsCount: googleConnections.length,
    microsoftConnectionsCount: microsoftConnections.length,
  });

  return convertedBusyPeriods;
}

/**
 * Converts busy periods from UTC to specified timezone
 */
function convertBusyPeriodsToTimezone(
  busyPeriods: BusyPeriod[],
  timezone: string,
): BusyPeriod[] {
  return busyPeriods.map((period) => {
    const startInTZ = new TZDate(period.start, timezone);
    const endInTZ = new TZDate(period.end, timezone);

    return {
      start: format(startInTZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
      end: format(endInTZ, "yyyy-MM-dd'T'HH:mm:ssXXX"),
    };
  });
}

/**
 * Parse a date string (YYYY-MM-DD) or ISO date string and create a TZDate in the target timezone.
 * This ensures the date is interpreted as that calendar date in the target timezone,
 * not as a UTC timestamp that gets shifted.
 */
function parseDateInTimezone(
  dateInput: string | Date,
  timezone: string,
): TZDate {
  if (dateInput instanceof Date) {
    // For backwards compatibility: if a Date object is passed, use its UTC date components
    // to construct the date in the target timezone
    const year = dateInput.getUTCFullYear();
    const month = dateInput.getUTCMonth();
    const day = dateInput.getUTCDate();
    return new TZDate(year, month, day, 0, 0, 0, 0, timezone);
  }

  // Handle ISO date strings (YYYY-MM-DD) or datetime strings
  const dateStr = dateInput.includes("T") ? dateInput.split("T")[0] : dateInput;
  const [year, month, day] = dateStr.split("-").map(Number);
  return new TZDate(year, month - 1, day, 0, 0, 0, 0, timezone);
}

function mustReadConnection(
  failClosed:
    | boolean
    | ((connection: { id: string; emailAccountId: string }) => boolean),
  connection: { id: string; emailAccountId: string },
) {
  return typeof failClosed === "function" ? failClosed(connection) : failClosed;
}
