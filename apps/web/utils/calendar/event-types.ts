import type { BookingLinkLocationType } from "@/generated/prisma/enums";

export interface CalendarEventAttendee {
  declined?: boolean;
  email: string;
  name?: string;
  /** A room or piece of equipment booked for the meeting, not a person. */
  resource?: boolean;
  /** The provider marks this entry as the connected calendar's own account. */
  self?: boolean;
}

export interface CalendarEvent {
  // All-day items span whole dates: startTime is the first day and endTime the
  // day after the last, both at UTC midnight, so they are dates, not instants.
  allDay?: boolean;
  attendees: CalendarEventAttendee[];
  /** The connected calendar account the event was read from. */
  calendarEmail?: string;
  description?: string;
  endTime: Date;
  eventUrl?: string;
  id: string;
  // True when the connected calendar's own account organizes the event. This is
  // relative to the calendar connection, which is not always the EmailAccount.
  isOrganizer?: boolean;
  location?: string;
  organizerEmail?: string;
  startTime: Date;
  title: string;
  videoConferenceLink?: string;
}

export interface CalendarEventWriteInput {
  // All-day items span whole dates: startTime is the first day and endTime the
  // day after the last, both at UTC midnight.
  allDay?: boolean;
  attendees: CalendarEventAttendee[];
  calendarId: string;
  description?: string;
  endTime: Date;
  locationType: BookingLinkLocationType;
  locationValue?: string | null;
  startTime: Date;
  timezone: string;
  title: string;
}

export interface CalendarEventWriteResult {
  eventUrl?: string;
  id: string;
  providerCalendarId: string;
  videoConferenceLink?: string;
}

export interface CalendarEventCancelInput {
  calendarId: string;
  eventId: string;
}

export interface CalendarEventUpdateInput {
  calendarId: string;
  endTime: Date;
  eventId: string;
  startTime: Date;
  timezone: string;
}

export interface CalendarEventProvider {
  /** The connected calendar account's address. */
  readonly calendarEmail?: string;
  fetchEvents(options: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }): Promise<CalendarEvent[]>;
  fetchEventsWithAttendee(options: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]>;
}
