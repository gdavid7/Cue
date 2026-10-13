import { type InferUITool, tool } from "ai";
import { z } from "zod";
import type { Logger } from "@/utils/logger";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { posthogCaptureEvent } from "@/utils/posthog";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import { addToCalendar } from "@/utils/calendar/add-to-calendar";
import { SafeError } from "@/utils/error";

const getCalendarEventsInputSchema = z.object({
  startDate: z
    .string()
    .describe(
      "Start of date range in ISO 8601 format (e.g. 2026-03-18T00:00:00Z)",
    ),
  endDate: z
    .string()
    .describe(
      "End of date range in ISO 8601 format (e.g. 2026-03-19T00:00:00Z)",
    ),
  maxResults: z
    .number()
    .optional()
    .describe("Maximum number of events to return. Defaults to 25."),
});

export const getCalendarEventsTool = ({
  email,
  emailAccountId,
  logger,
}: {
  email: string;
  emailAccountId: string;
  logger: Logger;
}) =>
  tool({
    description: "Fetch calendar events for a date range.",
    inputSchema: getCalendarEventsInputSchema,
    execute: async ({ startDate, endDate, maxResults }) => {
      trackToolCall({ tool: "get_calendar_events", email, logger });

      try {
        const providers = await createCalendarEventProviders(
          emailAccountId,
          logger,
        );

        if (providers.length === 0) {
          return {
            error:
              "No calendar connected. The user needs to connect their calendar in Inbox Zero settings.",
          };
        }

        const allResults = await Promise.allSettled(
          providers.map((provider) =>
            provider.fetchEvents({
              timeMin: new Date(startDate),
              timeMax: new Date(endDate),
              maxResults: maxResults ?? 25,
            }),
          ),
        );

        const fulfilled = allResults.filter(
          (r): r is PromiseFulfilledResult<CalendarEvent[]> =>
            r.status === "fulfilled",
        );
        const rejectedCount = allResults.length - fulfilled.length;

        if (rejectedCount > 0) {
          logger.warn("Some calendar providers failed", {
            count: rejectedCount,
          });
        }

        if (fulfilled.length === 0) {
          return {
            error:
              "All calendar providers failed to fetch events. Please try again later.",
          };
        }

        const events = fulfilled
          .flatMap((r) => r.value)
          .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())
          .slice(0, maxResults ?? 25)
          .map((event) => ({
            title: event.title,
            startTime: event.startTime.toISOString(),
            endTime: event.endTime.toISOString(),
            location: event.location ?? null,
            attendees: event.attendees.map((a) => a.email),
            videoConferenceLink: event.videoConferenceLink ?? null,
          }));

        return { events, count: events.length };
      } catch (error) {
        logger.error("Failed to fetch calendar events", { error });
        return { error: "Failed to fetch calendar events" };
      }
    },
  });

export type GetCalendarEventsTool = InferUITool<
  ReturnType<typeof getCalendarEventsTool>
>;

const addToCalendarInputSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .describe('Short event title, e.g. "CSE 151B group meeting".'),
  start: z
    .string()
    .describe(
      "Start as an ISO 8601 date-time with offset, or a date (YYYY-MM-DD) for an all-day item such as a deadline.",
    ),
  end: z
    .string()
    .optional()
    .describe(
      "End, same format as start. Omit for a one-hour event, or for an all-day item.",
    ),
  location: z
    .string()
    .optional()
    .describe("Place or video link, as written in the email."),
});

export const addToCalendarTool = ({
  email,
  emailAccountId,
  timezone,
  logger,
}: {
  email: string;
  emailAccountId: string;
  timezone: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Add an event to the user's own calendar (the Google or Microsoft calendar connected to Cue). Use when the user asks to put something on their calendar, such as a meeting, interview, or deadline from an email. Read the email first with readEmail and use only the date, time, and place it states; if the time or time zone is unclear, ask instead of guessing. Confirm the title and time with the user before calling. Creates the event only; never invites other people.",
    inputSchema: addToCalendarInputSchema,
    execute: async ({ title, start, end, location }) => {
      trackToolCall({ tool: "add_to_calendar", email, logger });

      try {
        const event = await addToCalendar({
          emailAccountId,
          title,
          start,
          end,
          location,
          timezone,
          logger,
        });
        return { added: true, ...event };
      } catch (error) {
        if (error instanceof SafeError) return { error: error.message };
        logger.error("Failed to add event to calendar", { error });
        return { error: "Failed to add the event to the calendar" };
      }
    },
  });

export type AddToCalendarTool = InferUITool<
  ReturnType<typeof addToCalendarTool>
>;

async function trackToolCall({
  tool: toolName,
  email,
  logger,
}: {
  tool: string;
  email: string;
  logger: Logger;
}) {
  logger.trace("Tracking tool call", { tool: toolName, email });
  return posthogCaptureEvent(email, "AI Assistant Chat Tool Call", {
    tool: toolName,
  });
}
