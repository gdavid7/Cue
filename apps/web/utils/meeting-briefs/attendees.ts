import type {
  CalendarEvent,
  CalendarEventAttendee,
} from "@/utils/calendar/event-types";
import {
  canonicalizeEmailAddress,
  extractDomainFromEmail,
  isSameOrganization,
} from "@/utils/email";

interface PartitionedAttendees {
  external: CalendarEventAttendee[];
  internal: CalendarEventAttendee[];
}

/**
 * `ownAddresses` are the user's other connected mailboxes: a meeting with
 * yourself at another address has no guest to brief on.
 */
export function partitionAttendeesForBriefing(
  event: CalendarEvent,
  userEmail: string,
  ownAddresses: string[] = [],
): PartitionedAttendees {
  const normalizedUserEmail = userEmail.trim().toLowerCase();
  const own = new Set(ownAddresses.map(canonicalizeEmailAddress));

  const external: CalendarEventAttendee[] = [];
  const internal: CalendarEventAttendee[] = [];

  for (const attendee of event.attendees) {
    const attendeeEmail = attendee.email.trim().toLowerCase();
    if (!attendeeEmail || attendeeEmail === normalizedUserEmail) continue;
    if (own.has(canonicalizeEmailAddress(attendeeEmail))) continue;
    if (!extractDomainFromEmail(attendeeEmail)) continue;

    if (isSameOrganization(attendeeEmail, normalizedUserEmail)) {
      internal.push(attendee);
    } else {
      external.push(attendee);
    }
  }

  return { external, internal };
}
