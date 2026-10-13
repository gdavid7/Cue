import { orgOf } from "@cue/context";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { isExaSearchEnabled, searchExa } from "@/utils/exa/search";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { domainOf } from "@/utils/thread-context/linked-pages";

const WINDOW_DAYS = 2;
const MAX_MEETINGS = 3;
const NEWS_RESULTS = 3;
const NEWS_MAX_AGE_DAYS = 14;
const CACHE_TTL_SECONDS = 4 * 60 * 60;

export type MeetingNews = {
  eventId: string;
  title: string;
  startTime: string;
  organization: string;
  news: {
    title: string;
    url: string;
    domain: string;
    publishedDate?: string;
  }[];
};

/**
 * Recent public news about the outside organization in each meeting of the
 * next two days, so the user walks in knowing what's going on with them.
 * Searched, not written: no model call. News is the same for everyone, so
 * it's cached by organization.
 */
export async function getMeetingNews({
  emailAccountId,
  userEmail,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  logger: Logger;
  now?: Date;
}): Promise<MeetingNews[]> {
  if (!isExaSearchEnabled()) return [];
  const { events } = await fetchCalendarEventsInWindow({
    emailAccountId,
    timeMin: now,
    timeMax: new Date(now.getTime() + WINDOW_DAYS * 86_400_000),
    maxResultsPerProvider: 20,
    logger,
  });

  const meetings = meetingOrganizations(events, userEmail).slice(
    0,
    MAX_MEETINGS,
  );
  const withNews = await Promise.all(
    meetings.map(async ({ event, organization }) => ({
      eventId: event.id,
      title: event.title,
      startTime: event.startTime.toISOString(),
      organization,
      news: await organizationNews({ organization, logger, now }),
    })),
  );
  return withNews.filter((meeting) => meeting.news.length);
}

/**
 * Each upcoming meeting's outside organization: the one most of its other
 * attendees work at, leaving out the user's own and consumer mail domains.
 * An organization shows once, for its first meeting.
 */
export function meetingOrganizations(
  events: CalendarEvent[],
  userEmail: string,
): { event: CalendarEvent; organization: string }[] {
  const self = userEmail.trim().toLowerCase();
  const ownOrg = orgOf(self);
  const seen = new Set<string>();
  const meetings: { event: CalendarEvent; organization: string }[] = [];
  for (const event of [...events].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  )) {
    const counts = new Map<string, number>();
    for (const attendee of event.attendees) {
      const email = attendee.email.trim().toLowerCase();
      if (attendee.declined || email === self) continue;
      const org = orgOf(email);
      if (!org || org === ownOrg) continue;
      counts.set(org, (counts.get(org) ?? 0) + 1);
    }
    const organization = [...counts.entries()].sort(
      (a, b) => b[1] - a[1],
    )[0]?.[0];
    if (!organization || seen.has(organization)) continue;
    seen.add(organization);
    meetings.push({ event, organization });
  }
  return meetings;
}

async function organizationNews({
  organization,
  logger,
  now,
}: {
  organization: string;
  logger: Logger;
  now: Date;
}): Promise<MeetingNews["news"]> {
  const key = `meeting-news:${organization}`;
  const cached = await redis.get<MeetingNews["news"]>(key).catch(() => null);
  if (cached) return cached;
  try {
    const results = await searchExa({
      query: `${organization} news`,
      numResults: NEWS_RESULTS,
      maxTextCharacters: 200,
      startPublishedDate: new Date(
        now.getTime() - NEWS_MAX_AGE_DAYS * 86_400_000,
      ),
      logger,
    });
    const news = results.map((result) => ({
      title: result.title,
      url: result.url,
      domain: domainOf(result.url),
      ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
    }));
    await redis.set(key, news, { ex: CACHE_TTL_SECONDS }).catch(() => null);
    return news;
  } catch (error) {
    logger.warn("Failed to search news for a meeting", { error });
    return [];
  }
}
