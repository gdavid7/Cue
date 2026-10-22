import type {
  CalendarEvent,
  CalendarEventAttendee,
} from "@/utils/calendar/event-types";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import prisma from "@/utils/prisma";
import { onePerExternalAccount } from "@/utils/user/owned-by-same-user";

// What counts as a meeting on the user's day, shared by Today's Next up and
// its Your day strip so the two never disagree about the same calendar.

export type CalendarAccount = {
  id: string;
  provider: string;
  email: string;
  isConnected: boolean;
};

/** Every calendar connection of the person who owns `emailAccountId`. */
export function getCalendarAccounts(
  emailAccountId: string,
): Promise<CalendarAccount[]> {
  return prisma.calendarConnection.findMany({
    where: calendarConnectionsWhere(emailAccountId),
    select: { id: true, provider: true, email: true, isConnected: true },
  });
}

/**
 * The user's own addresses, lowercased: every mailbox they connected and every
 * calendar account, since events come from all of their calendars.
 */
export function buildSelfAddresses({
  ownAddresses,
  calendarAccounts,
}: {
  ownAddresses: string[];
  calendarAccounts: Pick<CalendarAccount, "email">[];
}): ReadonlySet<string> {
  return new Set(
    [...ownAddresses, ...calendarAccounts.map((account) => account.email)].map(
      (email) => email.toLowerCase(),
    ),
  );
}

/** An attendee entry that is the user, on any of their addresses. */
export function isOwnAttendee(
  attendee: CalendarEventAttendee,
  self: ReadonlySet<string>,
) {
  return Boolean(attendee.self) || self.has(attendee.email.toLowerCase());
}

/**
 * The user declined: every entry that is them did. Invited at a personal and
 * a work address, a meeting declined at one but accepted at the other is
 * still on. Where the provider marks the calendar's own entry, that one speaks.
 */
export function isDeclinedByUser(
  event: Pick<CalendarEvent, "attendees">,
  self: ReadonlySet<string>,
) {
  const own = event.attendees.filter((attendee) =>
    isOwnAttendee(attendee, self),
  );
  const marked = own.filter((attendee) => attendee.self);
  const entries = marked.length ? marked : own;
  return entries.length > 0 && entries.every((attendee) => attendee.declined);
}

/**
 * A meeting that fills the user's day: one with a time (all-day entries such
 * as holidays don't) that they haven't declined.
 */
export function isMeetingForUser(
  event: Pick<CalendarEvent, "allDay" | "attendees">,
  self: ReadonlySet<string>,
) {
  return !event.allDay && !isDeclinedByUser(event, self);
}

/**
 * With two calendar accounts each meeting says whose calendar it's on. A
 * disconnected one, or one connected from two mailboxes, is no second source.
 */
export function shouldLabelCalendars(calendarAccounts: CalendarAccount[]) {
  return (
    onePerExternalAccount(
      calendarAccounts.filter((account) => account.isConnected),
    ).length > 1
  );
}
