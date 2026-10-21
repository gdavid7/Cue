import { SafeError } from "@/utils/error";
import type {
  CalendarInvitation,
  InvitationResponse,
  InvitationEvent,
} from "@/utils/calendar/invitations/parser";
import { escapeODataString } from "@/utils/outlook/odata-escape";
import type { Client } from "@microsoft/microsoft-graph-client";
import { getCalendarClientWithRefresh } from "@/utils/outlook/calendar-client";
import type {
  CalendarEvent,
  CalendarEventCancelInput,
  CalendarEventProvider,
  CalendarEventUpdateInput,
  CalendarEventWriteInput,
  CalendarEventWriteResult,
} from "@/utils/calendar/event-types";
import { findVideoConferenceLink } from "@/utils/calendar/video-conference-link";
import { BookingLinkLocationType } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import { sleep } from "@/utils/sleep";

// PidLidAppointmentSequence tracks the organizer's meeting revision.
const APPOINTMENT_SEQUENCE_PROPERTY =
  "Integer {00062002-0000-0000-C000-000000000046} Id 0x8201";
const APPOINTMENT_SEQUENCE_EXPAND = `singleValueExtendedProperties($filter=id eq '${APPOINTMENT_SEQUENCE_PROPERTY}')`;
const ONLINE_MEETING_JOIN_URL_POLL_DELAYS_MS = [500, 1000, 2000] as const;
const MICROSOFT_TEAMS_PROVIDER = "teamsForBusiness";

export interface MicrosoftCalendarConnectionParams {
  accessToken: string | null;
  calendarEmail?: string;
  /** Calendars to read events from; the default calendar when empty. */
  calendarIds?: string[];
  connectionId: string;
  expiresAt: number | null;
  refreshToken: string | null;
}

type MicrosoftEvent = {
  id?: string;
  iCalUId?: string;
  isAllDay?: boolean;
  subject?: string;
  body?: { content?: string };
  bodyPreview?: string;
  start?: { dateTime?: string };
  end?: { dateTime?: string };
  attendees?: Array<{
    emailAddress?: { address?: string; name?: string };
    status?: { response?: string };
  }>;
  isOrganizer?: boolean;
  organizer?: { emailAddress?: { address?: string; name?: string } };
  location?: { displayName?: string };
  webLink?: string;
  onlineMeeting?: { joinUrl?: string };
  onlineMeetingUrl?: string;
  isOnlineMeeting?: boolean;
  onlineMeetingProvider?: string;
  isCancelled?: boolean;
  singleValueExtendedProperties?: Array<{ id: string; value: string }>;
  responseStatus?: { response?: string };
};

type MicrosoftCalendarOnlineMeetingSettings = {
  allowedOnlineMeetingProviders?: string[];
  defaultOnlineMeetingProvider?: string;
};

type MicrosoftOnlineMeetingFields = {
  isOnlineMeeting: true;
  onlineMeetingProvider: string;
};

export class MicrosoftCalendarEventProvider implements CalendarEventProvider {
  private readonly connection: MicrosoftCalendarConnectionParams;
  private readonly logger: Logger;
  readonly calendarEmail?: string;

  constructor(connection: MicrosoftCalendarConnectionParams, logger: Logger) {
    this.connection = connection;
    this.calendarEmail = connection.calendarEmail;
    this.logger = logger;
  }

  private async getClient(): Promise<Client> {
    return getCalendarClientWithRefresh({
      accessToken: this.connection.accessToken,
      refreshToken: this.connection.refreshToken,
      expiresAt: this.connection.expiresAt,
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

    const events = await this.listCalendarView(client, {
      timeMin,
      timeMax,
      top: maxResults * 3, // Fetch more to filter by attendee
    });

    // Filter to events that have this attendee
    return events
      .filter((event) =>
        event.attendees?.some(
          (a) =>
            a.emailAddress?.address?.toLowerCase() ===
            attendeeEmail.toLowerCase(),
        ),
      )
      .slice(0, maxResults)
      .map((event) => this.parseEvent(event));
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
    this.logger.trace("Starting Microsoft calendar client setup");
    const client = await this.getClient();
    this.logger.trace("Completed Microsoft calendar client setup");

    // calendarView requires both start and end times, default to 30 days from timeMin
    const effectiveTimeMax =
      timeMax ?? new Date(timeMin.getTime() + 30 * 24 * 60 * 60 * 1000);

    this.logger.trace("Starting Microsoft calendar events request");
    const events = await this.listCalendarView(client, {
      timeMin,
      timeMax: effectiveTimeMax,
      top: maxResults || 100,
    });
    this.logger.trace("Completed Microsoft calendar events request", {
      eventCount: events.length,
    });

    return events
      .slice(0, maxResults || 100)
      .map((event) => this.parseEvent(event));
  }

  /**
   * Events overlapping the range on each of the user's selected calendars,
   * merged in start order. An event on several of them is kept once.
   */
  private async listCalendarView(
    client: Client,
    { timeMin, timeMax, top }: { timeMin: Date; timeMax: Date; top: number },
  ): Promise<MicrosoftEvent[]> {
    const paths = this.connection.calendarIds?.length
      ? this.connection.calendarIds.map(
          (id) => `/me/calendars/${encodeURIComponent(id)}/calendarView`,
        )
      : ["/me/calendar/calendarView"];
    const lists = await Promise.all(
      paths.map(async (path) => {
        try {
          // calendarView returns events overlapping the range, unlike /events
          const response = await client
            .api(path)
            // A zoned date (TZDate) prints its offset, and Graph reads the
            // query's unencoded "+" as a space, so always send UTC.
            .query({
              startDateTime: new Date(timeMin.getTime()).toISOString(),
              endDateTime: new Date(timeMax.getTime()).toISOString(),
            })
            .top(top)
            .orderby("start/dateTime")
            .get();
          return (response.value || []) as MicrosoftEvent[];
        } catch (error) {
          // A calendar removed or unshared since it was synced has no events.
          if ((error as { statusCode?: number })?.statusCode === 404) {
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
        const key = `${event.iCalUId ?? event.id}|${event.start?.dateTime}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(
        (a, b) =>
          parseGraphDateTime(a.start?.dateTime).getTime() -
          parseGraphDateTime(b.start?.dateTime).getTime(),
      );
  }

  async findInvitationEvent(
    invitation: CalendarInvitation,
    mailboxEventId?: string,
  ): Promise<InvitationEvent | null> {
    if (invitation.recurrenceId) return null;
    const client = await this.getClient();
    const event = mailboxEventId
      ? await this.getMailboxEvent(client, mailboxEventId)
      : await this.findEventByUid(client, invitation.uid);
    if (!event) return null;
    if (event.isCancelled)
      throw new SafeError("This event has been cancelled.");
    if (
      !event.id ||
      event.isOrganizer ||
      event.organizer?.emailAddress?.address?.toLowerCase() !==
        invitation.organizer
    )
      return null;
    if (
      !event.attendees?.some(
        (attendee) =>
          attendee.emailAddress?.address?.toLowerCase() === invitation.attendee,
      )
    )
      return null;
    const revision = event.singleValueExtendedProperties?.find(
      (property) =>
        property.id.toLowerCase() ===
        APPOINTMENT_SEQUENCE_PROPERTY.toLowerCase(),
    )?.value;
    if (!revision || !/^\d+$/.test(revision)) return null;
    if (Number(revision) !== invitation.sequence)
      throw new SafeError(
        "This invitation has changed. Please respond to the latest invitation in your calendar.",
      );
    const response = event.responseStatus?.response;
    return {
      id: event.id,
      response:
        response === "tentativelyAccepted" ? "tentative" : (response ?? null),
    };
  }

  // Exchange rewrites the iCalUId of invitations that other calendar providers
  // sent, so a UID lookup misses them. The mailbox links the invitation email to
  // the event it created instead, which is the id the caller passes here.
  private async getMailboxEvent(client: Client, eventId: string) {
    try {
      return (await client
        .api(`/me/events/${encodeURIComponent(eventId)}`)
        .query({ $expand: APPOINTMENT_SEQUENCE_EXPAND })
        .get()) as MicrosoftEvent;
    } catch (error) {
      this.logger.warn("Failed to read the event linked to the invitation", {
        error,
      });
      return null;
    }
  }

  private async findEventByUid(client: Client, uid: string) {
    const result = await client
      .api("/me/calendar/events")
      .query({
        $filter: `iCalUId eq '${escapeODataString(uid)}'`,
        $top: 2,
        $expand: APPOINTMENT_SEQUENCE_EXPAND,
      })
      .get();
    const events: MicrosoftEvent[] = result.value ?? [];
    if (events.length !== 1 || result["@odata.nextLink"]) return null;
    return events[0];
  }

  async respondToInvitation(
    eventId: string,
    _invitation: CalendarInvitation,
    response: InvitationResponse,
  ) {
    const client = await this.getClient();
    const action = {
      accepted: "accept",
      declined: "decline",
      tentative: "tentativelyAccept",
    }[response];
    await client
      .api(`/me/events/${encodeURIComponent(eventId)}/${action}`)
      .post({ sendResponse: true });
  }

  async createEvent(
    input: CalendarEventWriteInput,
  ): Promise<CalendarEventWriteResult> {
    const client = await this.getClient();
    const useMicrosoftTeams =
      input.locationType === BookingLinkLocationType.MICROSOFT_TEAMS;
    const onlineMeetingFields = useMicrosoftTeams
      ? await getOnlineMeetingFields({
          calendarId: input.calendarId,
          client,
          logger: this.logger,
        })
      : null;
    const requestedOnlineMeeting = Boolean(onlineMeetingFields);
    const response: MicrosoftEvent = await client
      .api(`/me/calendars/${input.calendarId}/events`)
      .post({
        subject: input.title,
        body: {
          contentType: "text",
          content: input.description || "",
        },
        // Graph wants an all-day item at midnight in a named time zone.
        ...(input.allDay
          ? {
              isAllDay: true,
              start: {
                dateTime: formatMicrosoftMidnight(input.startTime),
                timeZone: input.timezone,
              },
              end: {
                dateTime: formatMicrosoftMidnight(input.endTime),
                timeZone: input.timezone,
              },
            }
          : {
              start: {
                dateTime: formatMicrosoftUtcDateTime(input.startTime),
                timeZone: "UTC",
              },
              end: {
                dateTime: formatMicrosoftUtcDateTime(input.endTime),
                timeZone: "UTC",
              },
            }),
        attendees: input.attendees.map((attendee) => ({
          emailAddress: {
            address: attendee.email,
            name: attendee.name || attendee.email,
          },
          type: "required",
        })),
        ...(onlineMeetingFields ?? {}),
        location:
          !useMicrosoftTeams && input.locationValue
            ? { displayName: input.locationValue }
            : undefined,
      });

    let videoConferenceLink = getJoinUrl(response);

    // Graph initializes the online meeting after the event is created, so the
    // POST response sometimes returns before `onlineMeeting` is populated.
    // Refetch the event to retrieve the join URL when one was requested.
    if (requestedOnlineMeeting && !videoConferenceLink && response.id) {
      videoConferenceLink = await pollForOnlineMeetingJoinUrl({
        client,
        eventId: response.id,
        logger: this.logger,
      });
    }

    if (requestedOnlineMeeting && !videoConferenceLink && response.id) {
      try {
        const patched: MicrosoftEvent = await client
          .api(`/me/events/${response.id}`)
          .patch(onlineMeetingFields);
        videoConferenceLink = getJoinUrl(patched);
      } catch (error) {
        this.logger.warn("Failed to enable online meeting on Microsoft event", {
          eventId: response.id,
          error,
        });
      }
    }

    if (requestedOnlineMeeting && !videoConferenceLink && response.id) {
      videoConferenceLink = await pollForOnlineMeetingJoinUrl({
        client,
        eventId: response.id,
        logger: this.logger,
      });
    }

    if (requestedOnlineMeeting && !videoConferenceLink) {
      this.logger.warn(
        "Microsoft online meeting link missing after event creation",
        {
          eventId: response.id,
          isOnlineMeeting: response.isOnlineMeeting,
          onlineMeetingProvider: response.onlineMeetingProvider,
        },
      );
    }

    return {
      id: response.id || "",
      providerCalendarId: input.calendarId,
      eventUrl: response.webLink,
      videoConferenceLink,
    };
  }

  async cancelEvent(input: CalendarEventCancelInput): Promise<void> {
    const client = await this.getClient();

    await client
      .api(`/me/events/${input.eventId}/cancel`)
      .post({ comment: "" });
  }

  async updateEvent(input: CalendarEventUpdateInput): Promise<void> {
    const client = await this.getClient();

    await client.api(`/me/events/${input.eventId}`).patch({
      start: {
        dateTime: formatMicrosoftUtcDateTime(input.startTime),
        timeZone: "UTC",
      },
      end: {
        dateTime: formatMicrosoftUtcDateTime(input.endTime),
        timeZone: "UTC",
      },
    });
  }

  private parseEvent(event: MicrosoftEvent): CalendarEvent {
    // All-day items are whole dates; keep the day, not a zone-shifted instant.
    const allDay = !!event.isAllDay;
    const startTime = allDay
      ? new Date(`${event.start?.dateTime?.slice(0, 10)}T00:00:00Z`)
      : parseGraphDateTime(event.start?.dateTime);
    const endTime = allDay
      ? new Date(`${event.end?.dateTime?.slice(0, 10)}T00:00:00Z`)
      : parseGraphDateTime(event.end?.dateTime);
    return {
      ...(allDay ? { allDay } : {}),
      id: event.id || "",
      title: event.subject || "Untitled",
      description: event.bodyPreview || undefined,
      location: event.location?.displayName || undefined,
      eventUrl: event.webLink || undefined,
      videoConferenceLink:
        getJoinUrl(event) ||
        findVideoConferenceLink(
          event.location?.displayName,
          event.body?.content ?? event.bodyPreview,
        ),
      startTime,
      endTime,
      organizerEmail: event.organizer?.emailAddress?.address || undefined,
      isOrganizer: event.isOrganizer,
      attendees:
        event.attendees?.map((attendee) => ({
          email: attendee.emailAddress?.address || "",
          name: attendee.emailAddress?.name ?? undefined,
          declined: attendee.status?.response === "declined",
        })) || [],
    };
  }
}

// Graph answers in UTC unless asked otherwise, but leaves the zone off the
// string, which Date would read in the server's own zone.
function parseGraphDateTime(dateTime: string | undefined) {
  if (!dateTime) return new Date();
  return new Date(
    /(?:Z|[+-]\d{2}:?\d{2})$/.test(dateTime) ? dateTime : `${dateTime}Z`,
  );
}

function formatMicrosoftUtcDateTime(date: Date) {
  // Graph DateTimeTimeZone expects a local datetime for the supplied timezone.
  return date.toISOString().replace(/Z$/, "0000");
}

function formatMicrosoftMidnight(date: Date) {
  return `${date.toISOString().slice(0, 10)}T00:00:00.0000000`;
}

function getJoinUrl(event: MicrosoftEvent): string | undefined {
  return event.onlineMeeting?.joinUrl || event.onlineMeetingUrl;
}

async function getOnlineMeetingFields({
  calendarId,
  client,
  logger,
}: {
  calendarId: string;
  client: Client;
  logger: Logger;
}) {
  const settings = await getCalendarOnlineMeetingSettings({
    calendarId,
    client,
    logger,
  });

  let onlineMeetingProvider = settings?.defaultOnlineMeetingProvider;
  if (
    !settings ||
    settings.allowedOnlineMeetingProviders?.includes(MICROSOFT_TEAMS_PROVIDER)
  ) {
    onlineMeetingProvider = MICROSOFT_TEAMS_PROVIDER;
  }

  // Personal Outlook calendars advertise Skype but ignore meeting fields.
  if (
    !onlineMeetingProvider ||
    onlineMeetingProvider === "skypeForConsumer" ||
    onlineMeetingProvider === "unknown"
  ) {
    logger.warn("Calendar cannot generate an online meeting link", {
      calendarId,
      onlineMeetingProvider,
      allowedOnlineMeetingProviders: settings?.allowedOnlineMeetingProviders,
      defaultOnlineMeetingProvider: settings?.defaultOnlineMeetingProvider,
    });
    return null;
  }

  return {
    isOnlineMeeting: true,
    onlineMeetingProvider,
  } satisfies MicrosoftOnlineMeetingFields;
}

async function getCalendarOnlineMeetingSettings({
  calendarId,
  client,
  logger,
}: {
  calendarId: string;
  client: Client;
  logger: Logger;
}): Promise<MicrosoftCalendarOnlineMeetingSettings | null> {
  try {
    return await client
      .api(`/me/calendars/${calendarId}`)
      .select("id,allowedOnlineMeetingProviders,defaultOnlineMeetingProvider")
      .get();
  } catch (error) {
    logger.warn("Failed to fetch Microsoft calendar meeting providers", {
      calendarId,
      error,
    });
    return null;
  }
}

async function pollForOnlineMeetingJoinUrl({
  client,
  eventId,
  logger,
}: {
  client: Client;
  eventId: string;
  logger: Logger;
}) {
  for (const delayMs of [0, ...ONLINE_MEETING_JOIN_URL_POLL_DELAYS_MS]) {
    if (delayMs > 0) {
      await sleep(delayMs);
    }

    try {
      const event: MicrosoftEvent | undefined = await client
        .api(`/me/events/${eventId}`)
        .get();
      if (!event) continue;

      const joinUrl = getJoinUrl(event);
      if (joinUrl) return joinUrl;

      if (
        event.isOnlineMeeting === false &&
        event.onlineMeetingProvider === "unknown"
      ) {
        return;
      }
    } catch (error) {
      logger.warn("Failed to refetch Microsoft event for online meeting URL", {
        eventId,
        error,
      });
    }
  }

  return;
}
