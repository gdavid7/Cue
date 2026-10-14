import type {
  CalendarInvitation,
  InvitationResponse,
  InvitationEvent,
} from "@/utils/calendar/invitations/parser";
import { SafeError } from "@/utils/error";
import type { calendar_v3 } from "@googleapis/calendar";
import { randomUUID } from "node:crypto";
import { BookingLinkLocationType } from "@/generated/prisma/enums";
import { getCalendarClientWithRefresh } from "@/utils/calendar/client";
import type {
  CalendarEvent,
  CalendarEventCancelInput,
  CalendarEventProvider,
  CalendarEventUpdateInput,
  CalendarEventWriteInput,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";
import { findVideoConferenceLink } from "@/utils/calendar/video-conference-link";
import type { Logger } from "@/utils/logger";

export interface GoogleCalendarConnectionParams {
  accessToken: string | null;
  /** Calendars to read events from; the primary calendar when empty. */
  calendarIds?: string[];
  connectionId: string;
  emailAccountId: string;
  expiresAt: number | null;
  refreshToken: string | null;
}

export class GoogleCalendarEventProvider implements CalendarEventProvider {
  private readonly connection: GoogleCalendarConnectionParams;
  private readonly logger: Logger;

  constructor(connection: GoogleCalendarConnectionParams, logger: Logger) {
    this.connection = connection;
    this.logger = logger;
  }

  private async getClient(): Promise<calendar_v3.Calendar> {
    return getCalendarClientWithRefresh({
      accessToken: this.connection.accessToken,
      refreshToken: this.connection.refreshToken,
      expiresAt: this.connection.expiresAt,
      emailAccountId: this.connection.emailAccountId,
      connectionId: this.connection.connectionId,
      logger: this.logger,
    });
  }

  async fetchEventsWithAttendee({
    attendeeEmail,
    timeMin,
    timeMax,
    maxResults,
  }: {
    attendeeEmail: string;
    timeMin: Date;
    timeMax: Date;
    maxResults: number;
  }): Promise<CalendarEvent[]> {
    const client = await this.getClient();

    const events = await this.listEvents(client, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      maxResults,
      singleEvents: true,
      orderBy: "startTime",
      q: attendeeEmail,
    });

    // Filter to events that actually have this attendee
    return events
      .filter((event) =>
        event.attendees?.some(
          (a) => a.email?.toLowerCase() === attendeeEmail.toLowerCase(),
        ),
      )
      .map((event) => this.parseEvent(event))
      .slice(0, maxResults);
  }

  /**
   * Events from each of the user's selected calendars, merged in start order.
   * An event on several of them (e.g. a shared calendar) is kept once.
   */
  private async listEvents(
    client: calendar_v3.Calendar,
    params: Omit<calendar_v3.Params$Resource$Events$List, "calendarId">,
  ): Promise<calendar_v3.Schema$Event[]> {
    const calendarIds = this.connection.calendarIds?.length
      ? this.connection.calendarIds
      : ["primary"];
    const lists = await Promise.all(
      calendarIds.map(async (calendarId) => {
        try {
          const response = await client.events.list({ ...params, calendarId });
          return response.data.items || [];
        } catch (error) {
          // A calendar removed or unshared since it was synced has no events.
          if (isGoneError(error)) {
            this.logger.warn("Skipping a calendar that no longer exists");
            return [];
          }
          throw error;
        }
      }),
    );
    if (lists.length === 1) return lists[0];

    const seen = new Set<string>();
    return lists
      .flat()
      .filter((event) => {
        const key = `${event.iCalUID ?? event.id}|${event.start?.dateTime ?? event.start?.date}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort((a, b) => eventStart(a) - eventStart(b));
  }

  async fetchEvents({
    timeMin = new Date(),
    timeMax,
    maxResults,
  }: {
    timeMin?: Date;
    timeMax?: Date;
    maxResults?: number;
  }): Promise<CalendarEvent[]> {
    this.logger.info("Starting Google calendar client setup");
    const client = await this.getClient();
    this.logger.info("Completed Google calendar client setup");

    this.logger.info("Starting Google calendar events request");
    const events = await this.listEvents(client, {
      timeMin: timeMin?.toISOString(),
      timeMax: timeMax?.toISOString(),
      maxResults: maxResults || 10,
      singleEvents: true,
      orderBy: "startTime",
    });
    this.logger.info("Completed Google calendar events request", {
      eventCount: events.length,
    });

    return events
      .slice(0, maxResults || 10)
      .map((event) => this.parseEvent(event));
  }

  // Google Calendar keeps the organizer's UID, so it does not need the mailbox
  // event id that Outlook relies on.
  async findInvitationEvent(
    invitation: CalendarInvitation,
  ): Promise<InvitationEvent | null> {
    // An exception must never accidentally update the whole recurring series.
    if (invitation.recurrenceId) return null;
    const client = await this.getClient();
    let pageToken: string | undefined;
    let event: calendar_v3.Schema$Event | undefined;
    do {
      const { data } = await client.events.list({
        calendarId: "primary",
        iCalUID: invitation.uid,
        showDeleted: true,
        maxResults: 2500,
        pageToken,
      });
      for (const candidate of data.items ?? []) {
        if (candidate.recurringEventId) continue;
        if (event) return null;
        event = candidate;
      }
      pageToken = data.nextPageToken ?? undefined;
    } while (pageToken);
    if (!event) return null;
    if (event.status === "cancelled")
      throw new SafeError("This event has been cancelled.");
    if (
      !event.id ||
      event.organizer?.self ||
      event.organizer?.email?.toLowerCase() !== invitation.organizer
    )
      return null;
    const attendee = event.attendees?.find(
      (attendee) =>
        attendee.self && attendee.email?.toLowerCase() === invitation.attendee,
    );
    if (!attendee) return null;
    if ((event.sequence ?? 0) !== invitation.sequence)
      throw new SafeError(
        "This invitation has changed. Please respond to the latest invitation in your calendar.",
      );
    return { id: event.id, response: attendee.responseStatus ?? null };
  }

  async respondToInvitation(
    eventId: string,
    invitation: CalendarInvitation,
    response: InvitationResponse,
  ) {
    const client = await this.getClient();
    await client.events.patch({
      calendarId: "primary",
      eventId,
      sendUpdates: "all",
      requestBody: {
        attendeesOmitted: true,
        attendees: [{ email: invitation.attendee, responseStatus: response }],
      },
    });
  }

  async createEvent(
    input: CalendarEventWriteInput,
  ): Promise<CalendarEventWriteResult> {
    const client = await this.getClient();
    const useGoogleMeet =
      input.locationType === BookingLinkLocationType.GOOGLE_MEET;

    const response = await client.events.insert({
      calendarId: input.calendarId,
      conferenceDataVersion: useGoogleMeet ? 1 : undefined,
      sendUpdates: "all",
      requestBody: {
        summary: input.title,
        description: input.description,
        location: useGoogleMeet ? undefined : input.locationValue || undefined,
        start: input.allDay
          ? { date: toIsoDate(input.startTime) }
          : {
              dateTime: input.startTime.toISOString(),
              timeZone: input.timezone,
            },
        end: input.allDay
          ? { date: toIsoDate(input.endTime) }
          : { dateTime: input.endTime.toISOString(), timeZone: input.timezone },
        attendees: input.attendees.map((attendee) => ({
          email: attendee.email,
          displayName: attendee.name,
        })),
        conferenceData: useGoogleMeet
          ? {
              createRequest: {
                requestId: randomUUID(),
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            }
          : undefined,
      },
    });

    return {
      id: response.data.id || "",
      providerCalendarId: input.calendarId,
      eventUrl: response.data.htmlLink || undefined,
      videoConferenceLink:
        response.data.hangoutLink ||
        response.data.conferenceData?.entryPoints?.find(
          (entry) => entry.entryPointType === "video",
        )?.uri ||
        undefined,
    };
  }

  async cancelEvent(input: CalendarEventCancelInput): Promise<void> {
    const client = await this.getClient();

    await client.events.delete({
      calendarId: input.calendarId,
      eventId: input.eventId,
      sendUpdates: "all",
    });
  }

  async updateEvent(input: CalendarEventUpdateInput): Promise<void> {
    const client = await this.getClient();

    await client.events.patch({
      calendarId: input.calendarId,
      eventId: input.eventId,
      sendUpdates: "all",
      requestBody: {
        start: {
          dateTime: input.startTime.toISOString(),
          timeZone: input.timezone,
        },
        end: {
          dateTime: input.endTime.toISOString(),
          timeZone: input.timezone,
        },
      },
    });
  }

  private parseEvent(event: calendar_v3.Schema$Event): CalendarEvent {
    // An all-day item has only dates, which name days in no particular zone.
    const allDay = !event.start?.dateTime && !!event.start?.date;
    const startTime = new Date(
      event.start?.dateTime || event.start?.date || Date.now(),
    );
    const endTime = new Date(
      event.end?.dateTime || event.end?.date || Date.now(),
    );

    let videoConferenceLink = event.hangoutLink ?? undefined;
    if (event.conferenceData?.entryPoints) {
      const videoEntry = event.conferenceData.entryPoints.find(
        (entry) => entry.entryPointType === "video",
      );
      videoConferenceLink = videoEntry?.uri ?? videoConferenceLink;
    }
    videoConferenceLink ??= findVideoConferenceLink(
      event.location,
      event.description,
    );

    return {
      id: event.id || "",
      title: event.summary || "Untitled",
      description: event.description || undefined,
      location: event.location || undefined,
      eventUrl: event.htmlLink || undefined,
      videoConferenceLink,
      startTime,
      endTime,
      ...(allDay ? { allDay } : {}),
      organizerEmail: event.organizer?.email ?? undefined,
      isOrganizer: event.organizer?.self ?? undefined,
      attendees:
        event.attendees?.map((attendee) => ({
          email: attendee.email || "",
          name: attendee.displayName ?? undefined,
          declined: attendee.responseStatus === "declined",
        })) || [],
    };
  }
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function eventStart(event: calendar_v3.Schema$Event) {
  return new Date(event.start?.dateTime || event.start?.date || 0).getTime();
}

function isGoneError(error: unknown) {
  const status =
    (error as { status?: number; code?: number })?.status ??
    (error as { code?: number })?.code;
  return status === 404 || status === 410;
}
