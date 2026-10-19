import type { CalendarEvent } from "@/utils/calendar/event-types";

/** Someone else on an email, for matching meetings with them. */
export type InsightPerson = { email: string; name: string };

/** An upcoming meeting as the browser needs it to match people on emails. */
export type InsightEvent = {
  title: string;
  at: string;
  url?: string;
  /** Lowercased addresses of attendees who haven't declined. */
  attendees: string[];
};

export type ThreadMeeting = {
  title: string;
  at: string;
  with: string;
  url?: string;
};

export function toInsightEvent(event: CalendarEvent): InsightEvent {
  return {
    title: event.title,
    at: event.startTime.toISOString(),
    ...(event.eventUrl ? { url: event.eventUrl } : {}),
    attendees: event.attendees
      .filter((attendee) => !attendee.declined)
      .map((attendee) => attendee.email.toLowerCase()),
  };
}

/** The soonest meeting that someone on the email is also invited to. */
export function nextMeetingWith(
  people: InsightPerson[],
  events: InsightEvent[],
): ThreadMeeting | null {
  if (!people.length) return null;
  const byEmail = new Map(people.map((p) => [p.email, p]));
  let best: ThreadMeeting | null = null;
  for (const event of events) {
    const match = event.attendees
      .map((email) => byEmail.get(email))
      .find(Boolean);
    if (!match) continue;
    if (!best || event.at < best.at) {
      best = {
        title: event.title,
        at: event.at,
        with: match.name || match.email,
        url: event.url,
      };
    }
  }
  return best;
}
