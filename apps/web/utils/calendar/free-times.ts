import {
  type BookableSlot,
  generateBookableSlots,
  getZonedDateKey,
} from "@inboxzero/scheduling";
import { env } from "@/env";
import { BookingStatus } from "@/generated/prisma/enums";
import { DEFAULT_WEEKDAY_WINDOWS } from "@/utils/booking/default-availability";
import { getSlotIntervalMinutes } from "@/utils/booking/policy";
import { getCalendarAvailabilityErrorLogContext } from "@/utils/calendar/availability-error";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import { isGoogleVirtualCalendarId } from "@/utils/calendar/providers/google-calendar-id";
import { getUnifiedCalendarAvailability } from "@/utils/calendar/unified-availability";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { getAccountTimezone } from "@/utils/timezone";

export const FREE_TIMES_SEARCH_DAYS = 14;
const FREE_TIMES_COUNT = 3;
const DEFAULT_MEETING_MINUTES = 30;
const DEFAULT_MINIMUM_NOTICE_MINUTES = 120;

/**
 * The account's next few openings, read live from every calendar it uses for
 * availability, inside its weekly hours and long enough for its meeting
 * length. Nothing here is cached: a stale calendar would offer times that
 * are already taken.
 */
export async function getFreeTimes({
  emailAccountId,
  now = new Date(),
  logger,
}: {
  emailAccountId: string;
  now?: Date;
  logger: Logger;
}) {
  const [emailAccount, schedule, enabledCalendars] = await Promise.all([
    prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        timezone: true,
        calendarBookingLink: true,
        bookingLinks: {
          where: { isActive: true },
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            slug: true,
            durationMinutes: true,
            minimumNoticeMinutes: true,
            maxDaysAhead: true,
            availabilitySchedule: {
              select: {
                windows: {
                  select: {
                    weekday: true,
                    startMinutes: true,
                    endMinutes: true,
                  },
                },
              },
            },
          },
        },
      },
    }),
    prisma.availabilitySchedule.findFirst({
      where: { emailAccountId, isDefault: true },
      orderBy: { createdAt: "asc" },
      select: {
        windows: {
          select: { weekday: true, startMinutes: true, endMinutes: true },
        },
      },
    }),
    prisma.calendar.findMany({
      where: {
        isEnabled: true,
        connection: {
          ...calendarConnectionsWhere(emailAccountId),
          isConnected: true,
        },
      },
      select: { calendarId: true, connection: { select: { provider: true } } },
    }),
  ]);

  if (!emailAccount) throw new SafeError("Email account not found", 404);

  const cueBookingLink = emailAccount.bookingLinks[0];
  const bookingLink = getBookingLinkUrl({
    slug: cueBookingLink?.slug,
    calendarBookingLink: emailAccount.calendarBookingLink,
  });

  // Holidays and birthdays aren't read for availability, so a calendar list
  // with only those has nothing that could show the person as busy.
  const readableCalendars = enabledCalendars.filter(
    (calendar) =>
      !(
        isGoogleProvider(calendar.connection.provider) &&
        isGoogleVirtualCalendarId(calendar.calendarId)
      ),
  );
  if (!readableCalendars.length) {
    return { status: "no-calendar" as const, bookingLink };
  }

  const timezone = getAccountTimezone(emailAccount.timezone);
  const durationMinutes =
    cueBookingLink?.durationMinutes ?? DEFAULT_MEETING_MINUTES;
  // With a booking link, offer exactly what a guest on it could book: its own
  // schedule and how far ahead it takes bookings, as loadPublicBookingLink
  // reads them.
  const rules = cueBookingLink
    ? cueBookingLink.availabilitySchedule.windows
    : (schedule?.windows ?? DEFAULT_WEEKDAY_WINDOWS);
  const searchDays = cueBookingLink
    ? Math.min(FREE_TIMES_SEARCH_DAYS, cueBookingLink.maxDaysAhead)
    : FREE_TIMES_SEARCH_DAYS;
  const end = new Date(now.getTime() + searchDays * 24 * 60 * 60 * 1000);

  const [calendarBusy, bookingHolds] = await Promise.all([
    getUnifiedCalendarAvailability({
      emailAccountId,
      // Day keys in the account's zone: a Date would be read as its UTC day.
      startDate: getZonedDateKey(now, timezone),
      endDate: getZonedDateKey(end, timezone),
      timezone,
      logger,
      // A calendar that can't be read could hide a meeting, and a wrong time
      // is worse than none. A calendar the provider reports as not found
      // (deleted or unshared) is still skipped, as in the public booking
      // flow: it can't hold a meeting.
      failClosed: true,
      excludeGoogleVirtualCalendars: true,
    }).catch((error) => {
      logger.warn("Could not read calendars for free times", {
        error,
        ...getCalendarAvailabilityErrorLogContext(error),
      });
      throw new SafeError("Could not read your calendar", 503);
    }),
    // Bookings still being written to the calendar already hold their slot.
    prisma.booking.findMany({
      where: {
        emailAccountId,
        status: {
          in: [BookingStatus.PENDING_PROVIDER_EVENT, BookingStatus.CONFIRMED],
        },
        startTime: { lt: end },
        endTime: { gt: now },
      },
      select: { startTime: true, endTime: true },
    }),
  ]);

  const slotIntervalMinutes = getSlotIntervalMinutes(durationMinutes);
  const slots = generateBookableSlots({
    now,
    timezone,
    start: now,
    end,
    rules,
    busyPeriods: [
      ...calendarBusy,
      ...bookingHolds.map((hold) => ({
        start: hold.startTime,
        end: hold.endTime,
      })),
    ],
    policy: {
      durationMinutes,
      slotIntervalMinutes,
      minimumNoticeMinutes:
        cueBookingLink?.minimumNoticeMinutes ?? DEFAULT_MINIMUM_NOTICE_MINUTES,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      bookingWindowDays: searchDays,
    },
  });

  return {
    status: "ok" as const,
    timezone,
    durationMinutes,
    searchDays,
    slots: pickOpenings(slots, slotIntervalMinutes, FREE_TIMES_COUNT),
    bookingLink,
  };
}

/**
 * The first slot of each separate opening, so three free times read as three
 * real choices rather than 9:00, 9:30 and 10:00 of one free morning.
 */
export function pickOpenings(
  slots: BookableSlot[],
  slotIntervalMinutes: number,
  count: number,
): BookableSlot[] {
  const intervalMs = slotIntervalMinutes * 60 * 1000;
  const openings: BookableSlot[] = [];
  let previousStartMs: number | null = null;

  for (const slot of slots) {
    const startMs = new Date(slot.startTime).getTime();
    const continuesOpening =
      previousStartMs !== null && startMs - previousStartMs === intervalMs;
    previousStartMs = startMs;
    if (continuesOpening) continue;

    openings.push(slot);
    if (openings.length === count) break;
  }

  return openings;
}

function getBookingLinkUrl({
  slug,
  calendarBookingLink,
}: {
  slug: string | undefined;
  calendarBookingLink: string | null;
}) {
  if (slug) {
    return `${env.NEXT_PUBLIC_BASE_URL.replace(/\/$/, "")}/book/${encodeURIComponent(slug)}`;
  }
  // Typed in by the person; only a web link is safe to put in a message.
  if (!calendarBookingLink) return null;
  try {
    const url = new URL(calendarBookingLink.trim());
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
