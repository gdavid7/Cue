"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  addToCalendarBody,
  disconnectCalendarBody,
  toggleCalendarBody,
  updateTimezoneBody,
  updateBookingLinkBody,
} from "@/utils/actions/calendar.validation";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import { addToCalendar } from "@/utils/calendar/add-to-calendar";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";

export const disconnectCalendarAction = actionClient
  .metadata({ name: "disconnectCalendar" })
  .inputSchema(disconnectCalendarBody)
  .action(
    async ({ ctx: { emailAccountId }, parsedInput: { connectionId } }) => {
      const connection = await prisma.calendarConnection.findFirst({
        where: {
          id: connectionId,
          ...calendarConnectionsWhere(emailAccountId),
        },
        select: { provider: true, email: true },
      });

      if (!connection) {
        throw new SafeError("Calendar connection not found");
      }

      // Removes the row shown and this mailbox's own copy of that calendar.
      // Another mailbox's own copy stays, because that mailbox's briefs and
      // recorder read only its own calendars.
      await prisma.calendarConnection.deleteMany({
        where: {
          ...calendarConnectionsWhere(emailAccountId),
          provider: connection.provider,
          email: { equals: connection.email, mode: "insensitive" },
          OR: [{ id: connectionId }, { emailAccountId }],
        },
      });

      return { success: true };
    },
  );

export const toggleCalendarAction = actionClient
  .metadata({ name: "toggleCalendar" })
  .inputSchema(toggleCalendarBody)
  .action(
    async ({
      ctx: { emailAccountId },
      parsedInput: { calendarId, isEnabled },
    }) => {
      const updatedCalendar = await prisma.calendar.updateMany({
        where: {
          id: calendarId,
          connection: calendarConnectionsWhere(emailAccountId),
        },
        data: { isEnabled },
      });

      if (updatedCalendar.count === 0) {
        throw new SafeError("Calendar not found");
      }

      return { success: true };
    },
  );

export const updateEmailAccountTimezoneAction = actionClient
  .metadata({ name: "updateTimezone" })
  .inputSchema(updateTimezoneBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { timezone } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { timezone },
    });
  });

export const fillMissingTimezoneAction = actionClient
  .metadata({ name: "fillMissingTimezone" })
  .inputSchema(updateTimezoneBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { timezone } }) => {
    const result = await prisma.emailAccount.updateMany({
      where: { id: emailAccountId, timezone: null },
      data: { timezone },
    });
    return { updated: result.count > 0 };
  });

export const updateCalendarBookingLinkAction = actionClient
  .metadata({ name: "updateBookingLink" })
  .inputSchema(updateBookingLinkBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { bookingLink } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { calendarBookingLink: bookingLink || null },
    });
  });

export const addToCalendarAction = actionClient
  .metadata({ name: "addToCalendar" })
  .inputSchema(addToCalendarBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { title, start, end, location, timezone },
    }) =>
      addToCalendar({
        emailAccountId,
        title,
        start,
        end,
        location,
        timezone,
        logger,
      }),
  );
