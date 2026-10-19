import type { CalendarEvent } from "@/utils/calendar/event-types";
import { canonicalizeEmailAddress } from "@/utils/email";

type AccountEvents = { emailAccountId: string; events: CalendarEvent[] };

/**
 * One meeting on two calendars has a different event id on each. It is the
 * same meeting when its title, start and end match and, where both copies
 * list attendees, they share one, so two different 9:00 "Standup"s with
 * different people stay apart.
 */
export function isSameMeeting(a: CalendarEvent, b: CalendarEvent) {
  if (
    a.title.trim().toLowerCase() !== b.title.trim().toLowerCase() ||
    a.startTime.getTime() !== b.startTime.getTime() ||
    a.endTime.getTime() !== b.endTime.getTime()
  ) {
    return false;
  }
  if (!a.attendees.length || !b.attendees.length) return true;
  const attendees = new Set(
    a.attendees.map((attendee) => canonicalizeEmailAddress(attendee.email)),
  );
  return b.attendees.some((attendee) =>
    attendees.has(canonicalizeEmailAddress(attendee.email)),
  );
}

/**
 * Which copy of a meeting is briefed when it is on several of the user's
 * calendars: the same answer for every mailbox that has it, whichever asks,
 * so each can decide alone without racing the others.
 */
export function chooseBriefedCopy(
  event: CalendarEvent,
  emailAccountId: string,
  accounts: AccountEvents[],
): { emailAccountId: string; eventId: string } {
  let chosen = { emailAccountId, eventId: event.id };
  for (const account of accounts) {
    for (const other of account.events) {
      if (other !== event && !isSameMeeting(event, other)) continue;
      const candidate = {
        emailAccountId: account.emailAccountId,
        eventId: other.id,
      };
      if (comesFirst(candidate, chosen)) chosen = candidate;
    }
  }
  return chosen;
}

function comesFirst(
  a: { emailAccountId: string; eventId: string },
  b: { emailAccountId: string; eventId: string },
) {
  if (a.emailAccountId !== b.emailAccountId)
    return a.emailAccountId < b.emailAccountId;
  return a.eventId < b.eventId;
}
