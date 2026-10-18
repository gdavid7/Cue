import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import type { CalendarEventProvider } from "@/utils/calendar/event-types";
import { GoogleCalendarEventProvider } from "@/utils/calendar/providers/google-events";
import { MicrosoftCalendarEventProvider } from "@/utils/calendar/providers/microsoft-events";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import { onePerExternalAccount } from "@/utils/user/owned-by-same-user";

/**
 * Create calendar event providers for all of the person's connected calendars.
 * Fetches calendar connections once and creates providers that can be reused.
 */
export async function createCalendarEventProviders(
  emailAccountId: string,
  logger: Logger,
  options?: { ownConnectionsOnly?: boolean },
): Promise<CalendarEventProvider[]> {
  const allConnections = await prisma.calendarConnection.findMany({
    where: {
      ...calendarConnectionsWhere(emailAccountId, options),
      isConnected: true,
    },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      emailAccountId: true,
      email: true,
      provider: true,
      accessToken: true,
      refreshToken: true,
      expiresAt: true,
      // Events are read from the calendars the user selected, not just the
      // primary one (course and shared calendars live in the others).
      calendars: { where: { isEnabled: true }, select: { calendarId: true } },
    },
  });
  const connections = onePerExternalAccount(allConnections);

  if (connections.length === 0) {
    logger.info("No calendar connections found", { emailAccountId });
    return [];
  }

  const providers: CalendarEventProvider[] = [];

  for (const connection of connections) {
    if (!isUsableCalendarConnection(connection)) continue;

    try {
      providers.push(
        createCalendarEventProvider({
          connection: {
            ...connection,
            calendarIds: connection.calendars.map(
              (calendar) => calendar.calendarId,
            ),
          },
          emailAccountId: connection.emailAccountId,
          logger,
        }),
      );
    } catch (error) {
      logger.error("Failed to create calendar event provider", {
        provider: connection.provider,
        error,
      });
    }
  }

  return providers;
}

// Same connections createCalendarEventProviders can use. A missing refresh
// token or unknown provider builds no provider, so the chat tool would fail.
export async function hasUsableCalendarConnection(emailAccountId: string) {
  const connections = await prisma.calendarConnection.findMany({
    where: {
      ...calendarConnectionsWhere(emailAccountId),
      isConnected: true,
    },
    select: {
      provider: true,
      refreshToken: true,
    },
  });

  return connections.some(isUsableCalendarConnection);
}

export function createCalendarEventProvider({
  connection,
  emailAccountId,
  logger,
}: {
  connection: {
    accessToken: string | null;
    calendarIds?: string[];
    expiresAt: Date | null;
    id: string;
    provider: string;
    refreshToken: string | null;
  };
  emailAccountId: string;
  logger: Logger;
}) {
  const providerParams = {
    accessToken: connection.accessToken,
    calendarIds: connection.calendarIds,
    connectionId: connection.id,
    refreshToken: connection.refreshToken,
    expiresAt: connection.expiresAt?.getTime() ?? null,
    emailAccountId,
  };

  if (isGoogleProvider(connection.provider)) {
    return new GoogleCalendarEventProvider(providerParams, logger);
  }

  if (isMicrosoftProvider(connection.provider)) {
    return new MicrosoftCalendarEventProvider(providerParams, logger);
  }

  throw new SafeError("Unsupported calendar provider");
}

function isUsableCalendarConnection(connection: {
  provider: string;
  refreshToken: string | null;
}) {
  if (!connection.refreshToken) return false;

  return (
    isGoogleProvider(connection.provider) ||
    isMicrosoftProvider(connection.provider)
  );
}
