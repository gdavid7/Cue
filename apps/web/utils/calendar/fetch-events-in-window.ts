import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import type { Logger } from "@/utils/logger";
import { countConnectedCalendars } from "@/utils/calendar/connections";
import { isDeclinedByUser } from "@/utils/calendar/meeting-rules";

export interface CalendarEventsInWindow {
  /**
   * False when a provider errored or hit the result cap, so the event list is
   * only part of what is really on the calendar. Callers that infer deletion
   * from absence must not act on an incomplete list.
   */
  complete: boolean;
  events: CalendarEvent[];
  /** No calendar is connected, so there is nothing more to read. */
  noCalendarConnected?: boolean;
}

/**
 * Fetches events from every connected calendar in a time window, merged and
 * sorted by start time. A provider that fails is skipped rather than failing
 * the whole fetch, since most accounts have a single calendar and a partial
 * result still beats none.
 */
export async function fetchCalendarEventsInWindow({
  emailAccountId,
  timeMin,
  timeMax,
  maxResultsPerProvider,
  ownConnectionsOnly = false,
  includeCancelledTitles = false,
  selfAddresses,
  logger,
}: {
  emailAccountId: string;
  timeMin: Date;
  timeMax: Date;
  maxResultsPerProvider: number;
  /** See `calendarConnectionsWhere`: for automations that act once per calendar. */
  ownConnectionsOnly?: boolean;
  /**
   * Keep events renamed "Cancelled: …". Free/busy still counts one that wasn't
   * marked free, so a caller weighing busy time needs to see it.
   */
  includeCancelledTitles?: boolean;
  /**
   * The user's own addresses (`buildSelfAddresses`), so that of a meeting on
   * two calendars the copy they didn't decline is kept by the same rule the
   * caller filters with. Awaited only once the calendars have answered.
   */
  selfAddresses?: ReadonlySet<string> | Promise<ReadonlySet<string>>;
  logger: Logger;
}): Promise<CalendarEventsInWindow> {
  logger.trace("Starting calendar event window fetch");
  const scope = { ownConnectionsOnly };
  const providers = await createCalendarEventProviders(
    emailAccountId,
    logger,
    scope,
  );
  logger.trace("Created calendar event providers", {
    providerCount: providers.length,
  });
  // Zero providers never proves an empty calendar: connections are silently
  // skipped when their refresh token is gone or construction fails, and a sync
  // error may already have flipped them disconnected. Reporting complete here
  // would let callers treat every booked meeting as deleted.
  if (providers.length === 0) {
    const connectedCalendars = await countConnectedCalendars(
      emailAccountId,
      scope,
    );
    logger.info("Completed calendar event window fetch", {
      complete: false,
      eventCount: 0,
      failedProviders: 0,
      providerCount: 0,
    });
    return {
      events: [],
      complete: false,
      noCalendarConnected: connectedCalendars === 0,
    };
  }

  const connectedCalendars = await countConnectedCalendars(
    emailAccountId,
    scope,
  );
  logger.trace("Counted connected calendars", { connectedCalendars });

  const results = await Promise.allSettled(
    providers.map(async (provider, providerIndex) => {
      const providerLogger = logger.with({
        calendarProviderIndex: providerIndex,
      });
      providerLogger.trace("Starting calendar provider event fetch");

      try {
        const events = await provider.fetchEvents({
          timeMin,
          timeMax,
          maxResults: maxResultsPerProvider,
        });

        providerLogger.trace("Completed calendar provider event fetch", {
          eventCount: events.length,
        });
        const { calendarEmail } = provider;
        return calendarEmail
          ? events.map((event) => ({ ...event, calendarEmail }))
          : events;
      } catch (error) {
        providerLogger.error("Failed calendar provider event fetch", {
          error,
        });
        throw error;
      }
    }),
  );

  const fulfilled = results.filter(
    (result): result is PromiseFulfilledResult<CalendarEvent[]> =>
      result.status === "fulfilled",
  );

  const failedProviders = results.length - fulfilled.length;
  if (failedProviders > 0) {
    logger.warn("Calendar fetch returned partial results", {
      failedProviders,
      totalProviders: results.length,
    });
  }

  // A provider that filled the page may have more beyond it.
  const truncated = fulfilled.some(
    (result) => result.value.length >= maxResultsPerProvider,
  );

  const eventsByCalendar = fulfilled.map((result) => result.value);
  // Automations key their own rows by event id, so they keep every copy as
  // before rather than one whose id could change between runs.
  const events = (
    ownConnectionsOnly
      ? eventsByCalendar.flat()
      : dropCrossCalendarDuplicates(
          eventsByCalendar,
          await Promise.resolve(selfAddresses).catch(() => undefined),
        )
  ).sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  const filteredEvents = includeCancelledTitles
    ? events
    : events.filter((event) => !isCancelledEventTitle(event.title));
  const skippedCancelledEvents = events.length - filteredEvents.length;

  if (skippedCancelledEvents > 0) {
    logger.info("Skipping cancelled calendar events", {
      count: skippedCancelledEvents,
    });
  }

  // A connection that never became a provider is as much a blind spot as a
  // provider that errored, so any shortfall against the connected calendars
  // marks the fetch incomplete.
  const complete =
    failedProviders === 0 &&
    !truncated &&
    providers.length >= connectedCalendars;

  logger.info("Completed calendar event window fetch", {
    complete,
    eventCount: filteredEvents.length,
    failedProviders,
    providerCount: providers.length,
  });

  return { events: filteredEvents, complete };
}

// One meeting the person was invited to on two of their calendars (say their
// work and personal accounts) comes back from both, under different ids. The
// first calendar's copy is kept, unless a later one blocks the time more
// truly: one the person didn't decline over one they did, then one shown as
// busy over one shown as free. Later calendars' copies are matched against the first
// calendar to hold the meeting; two alike events on that one are both kept.
function dropCrossCalendarDuplicates(
  eventsByCalendar: CalendarEvent[][],
  selfAddresses: ReadonlySet<string> | undefined,
): CalendarEvent[] {
  const declined = (event: CalendarEvent) =>
    isDeclinedByUser(
      event,
      new Set([
        ...(selfAddresses ?? []),
        ...(event.calendarEmail ? [event.calendarEmail.toLowerCase()] : []),
      ]),
    );
  const rank = (event: CalendarEvent) => {
    if (declined(event)) return 2;
    return event.markedFree ? 1 : 0;
  };
  const keptAt = new Map<string, number>();
  const kept: CalendarEvent[] = [];
  for (const calendarEvents of eventsByCalendar) {
    const added = new Map<string, number>();
    for (const event of calendarEvents) {
      const key = meetingKey(event);
      const index = keptAt.get(key);
      if (index === undefined) {
        if (!added.has(key)) added.set(key, kept.length);
        kept.push(event);
      } else if (rank(event) < rank(kept[index])) {
        kept[index] = event;
      }
    }
    for (const [key, index] of added) keptAt.set(key, index);
  }
  return kept;
}

function meetingKey(event: CalendarEvent) {
  return [
    event.startTime.getTime(),
    event.endTime.getTime(),
    event.title.trim().toLowerCase(),
    event.videoConferenceLink ?? "",
  ].join("|");
}

// Some clients keep a cancelled event on the calendar with a renamed title
// instead of deleting it.
function isCancelledEventTitle(title: string): boolean {
  return /^\s*(?:cancelled|canceled)(?:\s+event)?\s*:/i.test(title);
}
