import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { isDuplicateError } from "@/utils/prisma-helpers";
import {
  checkExistingConnection,
  createCalendarConnection,
} from "@/utils/calendar/oauth-callback-helpers";
import { createGoogleCalendarProvider } from "@/utils/calendar/providers/google";
import { createMicrosoftCalendarProvider } from "@/utils/calendar/providers/microsoft";

/**
 * Sign-in asks for calendar access, so the mailbox's own tokens connect its
 * calendar without a separate step. Never throws: a calendar that can't be
 * connected here must not fail sign-in, and the Calendars page still offers
 * the separate connect flow.
 */
export async function connectCalendarAtSignIn({
  accountId,
  logger,
}: {
  accountId: string;
  logger: Logger;
}) {
  try {
    const account = await prisma.account.findUnique({
      where: { id: accountId },
      select: {
        provider: true,
        access_token: true,
        refresh_token: true,
        expires_at: true,
        emailAccount: { select: { id: true, email: true } },
      },
    });

    const emailAccount = account?.emailAccount;
    if (!account?.access_token || !account.refresh_token || !emailAccount)
      return;

    const provider = getCalendarProvider(account.provider, logger);
    if (!provider) return;

    const existing = await checkExistingConnection(
      emailAccount.id,
      provider.name,
      emailAccount.email,
    );

    // A working connection keeps its own grant. Sign-in tokens may lack
    // calendar access (granted before it was asked for, or unticked on the
    // consent screen), and swapping them in would break the calendar.
    if (existing?.isConnected) return;

    const tokens = {
      accessToken: account.access_token,
      refreshToken: account.refresh_token,
      expiresAt: account.expires_at,
    };

    let connectionId: string;
    if (existing) {
      await prisma.calendarConnection.update({
        where: { id: existing.id },
        data: { ...tokens, isConnected: true },
      });
      connectionId = existing.id;
    } else {
      try {
        const connection = await createCalendarConnection({
          provider: provider.name,
          email: emailAccount.email,
          emailAccountId: emailAccount.id,
          ...tokens,
        });
        connectionId = connection.id;
      } catch (error) {
        // A concurrent sign-in for the same mailbox is connecting it.
        if (isDuplicateError(error)) return;
        throw error;
      }
    }

    try {
      // Upserts calendars without touching isEnabled, so calendars the person
      // turned off stay off.
      await provider.syncCalendars(
        connectionId,
        tokens.accessToken,
        tokens.refreshToken,
        emailAccount.id,
        tokens.expiresAt,
      );
    } catch (error) {
      // Leave no dead connection behind for a grant without calendar access.
      if (existing) {
        await prisma.calendarConnection.updateMany({
          where: { id: connectionId },
          data: { isConnected: false },
        });
      } else {
        await prisma.calendarConnection.deleteMany({
          where: { id: connectionId },
        });
      }
      throw error;
    }

    logger.info("Calendar connected at sign-in", {
      emailAccountId: emailAccount.id,
      provider: provider.name,
      connectionId,
    });
  } catch (error) {
    logger.warn("Calendar not connected at sign-in", { accountId, error });
  }
}

function getCalendarProvider(provider: string, logger: Logger) {
  if (isGoogleProvider(provider)) return createGoogleCalendarProvider(logger);
  if (isMicrosoftProvider(provider))
    return createMicrosoftCalendarProvider(logger);
  return null;
}
