import {
  type AvailabilityRule,
  type BusyPeriod,
  generateBookableSlots,
} from "@inboxzero/scheduling";
import { getSlotIntervalMinutes } from "@/utils/booking/policy";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import { readFreeTimeAvailability } from "@/utils/calendar/free-times";
import {
  buildSelfAddresses,
  getCalendarAccounts,
  isMeetingForUser,
} from "@/utils/calendar/meeting-rules";
import type { Logger } from "@/utils/logger";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";

const NEXT_MEETING_WINDOW_MS = 8 * 60 * 60 * 1000;
const NEXT_MEETING_EVENTS_PER_CALENDAR = 25;
const FREE_HOUR_MINUTES = 60;

/**
 * The calendar-aware snooze presets for one account, as plain timestamps the
 * ordinary snooze takes. Each is null when it can't be worked out, so the
 * picker leaves it out; a calendar that fails to read never fails the other.
 * Only the two times leave the server: no event detail is returned or kept.
 */
export async function getSnoozeTimes({
  emailAccountId,
  userId,
  email,
  now = new Date(),
  logger,
}: {
  emailAccountId: string;
  userId: string;
  email: string;
  now?: Date;
  logger: Logger;
}) {
  const [afterNextMeeting, nextFreeHour] = await Promise.all([
    readAfterNextMeeting({ emailAccountId, userId, email, now, logger }).catch(
      (error) => {
        logger.warn("Could not read the next meeting for snooze", { error });
        return null;
      },
    ),
    readNextFreeHour({ emailAccountId, now, logger }).catch((error) => {
      logger.warn("Could not read the next free hour for snooze", { error });
      return null;
    }),
  ]);

  return {
    afterNextMeeting: afterNextMeeting?.toISOString() ?? null,
    nextFreeHour: nextFreeHour?.toISOString() ?? null,
  };
}

/**
 * The end of the meeting the user is in now, or else of the next one starting
 * within 8 hours. All-day entries, events marked free and meetings the user
 * declined don't count.
 */
export function resolveAfterNextMeeting({
  events,
  now,
  self,
}: {
  events: Pick<
    CalendarEvent,
    "allDay" | "attendees" | "endTime" | "markedFree" | "startTime"
  >[];
  now: Date;
  self: ReadonlySet<string>;
}): Date | null {
  const nowMs = now.getTime();
  const latestStartMs = nowMs + NEXT_MEETING_WINDOW_MS;
  let next: (typeof events)[number] | null = null;

  for (const event of events) {
    const startMs = event.startTime.getTime();
    if (startMs > latestStartMs || event.endTime.getTime() <= nowMs) continue;
    if (event.endTime.getTime() <= startMs || event.markedFree) continue;
    if (!isMeetingForUser(event, self)) continue;
    if (!next || startMs < next.startTime.getTime()) next = event;
  }

  return next ? new Date(next.endTime) : null;
}

/**
 * The start of the first free hour after now inside the account's working
 * hours, read in its own time zone and on the same half-hour grid as shared
 * free times.
 */
export function resolveNextFreeHour({
  now,
  timezone,
  rules,
  busyPeriods,
  searchDays,
}: {
  now: Date;
  timezone: string;
  rules: AvailabilityRule[];
  busyPeriods: BusyPeriod[];
  searchDays: number;
}): Date | null {
  const slots = generateBookableSlots({
    now,
    timezone,
    start: now,
    end: new Date(now.getTime() + searchDays * 24 * 60 * 60 * 1000),
    rules,
    busyPeriods,
    policy: {
      durationMinutes: FREE_HOUR_MINUTES,
      slotIntervalMinutes: getSlotIntervalMinutes(FREE_HOUR_MINUTES),
      minimumNoticeMinutes: 0,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      bookingWindowDays: searchDays,
    },
  });
  // Snoozing until this very moment would do nothing.
  const slot = slots.find(
    (candidate) => new Date(candidate.startTime).getTime() > now.getTime(),
  );
  return slot ? new Date(slot.startTime) : null;
}

async function readAfterNextMeeting({
  emailAccountId,
  userId,
  email,
  now,
  logger,
}: {
  emailAccountId: string;
  userId: string;
  email: string;
  now: Date;
  logger: Logger;
}) {
  const self = Promise.all([
    getUserOwnAddresses(userId).catch(() => []),
    getCalendarAccounts(emailAccountId),
  ]).then(([addresses, calendarAccounts]) =>
    buildSelfAddresses({
      ownAddresses: [email, ...addresses],
      calendarAccounts,
    }),
  );
  const calendar = await fetchCalendarEventsInWindow({
    emailAccountId,
    timeMin: now,
    timeMax: new Date(now.getTime() + NEXT_MEETING_WINDOW_MS),
    maxResultsPerProvider: NEXT_MEETING_EVENTS_PER_CALENDAR,
    selfAddresses: self,
    logger,
  });
  // A calendar that didn't answer could hold an earlier meeting, and naming
  // the wrong one is worse than offering none.
  if (!calendar.complete) return null;

  return resolveAfterNextMeeting({
    events: calendar.events,
    now,
    self: await self,
  });
}

async function readNextFreeHour({
  emailAccountId,
  now,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  logger: Logger;
}) {
  const availability = await readFreeTimeAvailability({
    emailAccountId,
    now,
    logger,
  });
  if (availability.status === "no-calendar") return null;

  return resolveNextFreeHour({ now, ...availability });
}
