import type { EmailInsight } from "@/utils/inbox-insights/extract-insight";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_DURATION_MS = 60 * 60 * 1000;
// A due time is a moment, not a meeting; a short block marks it.
const DEADLINE_DURATION_MS = 30 * 60 * 1000;

export type CalendarDraft = {
  title: string;
  allDay: boolean;
  /** YYYY-MM-DD when all-day, otherwise an ISO date-time. */
  start: string;
  /** ISO date-time; null for an all-day item. */
  end: string | null;
};

/**
 * The calendar item an email's insight suggests: an event or deadline on the
 * date it found. A date alone is an all-day item; a timed event lasts an hour
 * and a timed deadline is marked at its time. Null when there's nothing to
 * put on a calendar.
 */
export function getCalendarDraftFromInsight({
  insight,
  subject,
}: {
  insight: EmailInsight | null | undefined;
  subject: string;
}): CalendarDraft | null {
  if (!insight?.date) return null;
  if (insight.dateRole !== "event" && insight.dateRole !== "deadline") {
    return null;
  }

  const title = insight.task.trim() || subject.trim() || "Untitled";

  if (DATE_ONLY.test(insight.date)) {
    return { title, allDay: true, start: insight.date, end: null };
  }

  const start = new Date(insight.date);
  if (Number.isNaN(start.getTime())) return null;
  const duration =
    insight.dateRole === "event" ? EVENT_DURATION_MS : DEADLINE_DURATION_MS;

  return {
    title,
    allDay: false,
    start: start.toISOString(),
    end: new Date(start.getTime() + duration).toISOString(),
  };
}
