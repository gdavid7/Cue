import { TZDate } from "@date-fns/tz";
import { addDays, startOfDay } from "date-fns";
import { z } from "zod";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import type { Logger } from "@/utils/logger";
import { findIntegration } from "@/utils/mcp/integrations";
import { connectionExecutor } from "@/utils/mcp/provider-connection";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import { onePerIntegration } from "@/utils/mcp/user-connections";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";
import prisma from "@/utils/prisma";
import { calendarConnectionsWhere } from "@/utils/calendar/connections";
import { NEXT_UP_SHOWN, sortByDue } from "@/utils/home/today-constants";
import { redis } from "@/utils/redis";
import {
  isAppServerError,
  parseToolResult,
  searchCanvas,
  TimeoutError,
  withTimeout,
} from "@/utils/thread-context/connector-context";

const EVENTS_SHOWN = 2;
const DEADLINE_WINDOW_DAYS = 7;
// Today shouldn't wait on a slow app or calendar: what's late is left out.
const CALENDAR_TIMEOUT_MS = 3000;
const SOURCE_TIMEOUT_MS = 2500;
// Comfortably longer than connecting a calendar after sign-in takes.
const SIGN_IN_CALENDAR_GRACE_MS = 2 * 60 * 1000;
const DEADLINE_PAUSE_SECONDS = 5 * 60;
const TASK_LIST_CACHE_SECONDS = 7 * 24 * 60 * 60;
const EVENING_HOUR = 17;
const SUGGESTION_WINDOW_DAYS = 30;

export type NextUpItem = {
  id: string;
  kind: "event" | "deadline";
  title: string;
  at: string;
  /** When a meeting ends, which tells two calendars' copies of it apart. */
  endAt?: string;
  /** Due on a date rather than at a time: by the end of that day. */
  allDay?: boolean;
  /** Where it comes from, such as "Canvas". */
  source: string;
  /** Such as the course an assignment is for. */
  detail?: string;
  url?: string;
};

type Execute = (
  tool: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

type SourceContext = {
  /** The account the app was connected from, and its address. */
  accountId: string;
  accountEmail: string;
  now: Date;
  windowEnd: Date;
  timeZone: string;
};

/**
 * Apps whose work has due dates, with the mail domains they send from. The
 * domains only pick which app to suggest connecting, from sender metadata.
 */
const DEADLINE_SOURCES: Record<
  string,
  {
    domains: string[];
    fetch: (execute: Execute, context: SourceContext) => Promise<NextUpItem[]>;
  }
> = {
  canvas: { domains: ["instructure.com"], fetch: canvasDeadlines },
  jira: { domains: ["atlassian.net"], fetch: jiraDeadlines },
  asana: { domains: ["asana.com"], fetch: asanaDeadlines },
  clickup: { domains: ["clickup.com"], fetch: clickUpDeadlines },
};

/**
 * What's next for the user: their next meeting, and the next few meetings and
 * deadlines from connected apps, soonest first. Every source is optional and
 * bounded by a short timeout, so Today never waits on one.
 */
export async function getNextUp({
  emailAccountId,
  ownAddresses,
  timeZone,
  logger,
  now,
}: {
  emailAccountId: string;
  /** Every address the user has connected. */
  ownAddresses: string[] | Promise<string[]>;
  timeZone: string;
  logger: Logger;
  now: Date;
}) {
  const today = startOfDay(new TZDate(now, timeZone));
  const dayAfter = addDays(today, 2);

  const [calendar, deadlines, calendarAccounts, addresses] = await Promise.all([
    upcomingEvents({ emailAccountId, now, until: dayAfter, logger }),
    getDeadlines({
      emailAccountId,
      now,
      windowEnd: addDays(today, DEADLINE_WINDOW_DAYS + 1),
      timeZone,
      logger,
    }),
    prisma.calendarConnection.findMany({
      where: calendarConnectionsWhere(emailAccountId),
      select: { email: true },
    }),
    ownAddresses,
  ]);
  const suggestion = deadlines.connected
    ? null
    : await connectSuggestion({ emailAccountId, now, logger });

  // Events come from all of the person's calendars, so a decline by any of
  // their connected addresses or the calendars' own addresses counts.
  const self = new Set(
    [...addresses, ...calendarAccounts.map((account) => account.email)].map(
      (email) => email.toLowerCase(),
    ),
  );
  const events = calendar.events.filter(
    (event) =>
      !event.allDay &&
      event.startTime > now &&
      !event.attendees.some(
        (a) => a.declined && self.has(a.email.toLowerCase()),
      ),
  );
  // With two calendar accounts, each meeting says whose calendar it is on.
  const labelCalendars = distinctCalendars(calendarAccounts) > 1;
  const next = pickNextEvent(events, { now, today, timeZone });

  return {
    calendar: {
      connected: calendar.connected,
      next: next
        ? {
            title: next.event.title,
            at: next.event.startTime.toISOString(),
            url: next.event.eventUrl,
            tomorrow: next.tomorrow,
          }
        : null,
    },
    nextUp: sortByDue([
      ...events
        .slice(0, EVENTS_SHOWN)
        .map((event) => eventItem(event, labelCalendars)),
      ...deadlines.items,
    ]).slice(0, NEXT_UP_SHOWN),
    suggestion,
  };
}

async function upcomingEvents({
  emailAccountId,
  now,
  until,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  until: Date;
  logger: Logger;
}): Promise<{ connected: boolean; events: CalendarEvent[] }> {
  try {
    const result = await withTimeout(
      fetchCalendarEventsInWindow({
        emailAccountId,
        timeMin: now,
        timeMax: until,
        maxResultsPerProvider: 20,
        logger,
      }),
      CALENDAR_TIMEOUT_MS,
    );
    // Sign-in connects the calendar after it redirects, so a mailbox added
    // moments ago may not have it yet: that's unknown, not "not connected".
    if (
      result.noCalendarConnected &&
      (await isNewMailbox({ emailAccountId, now }))
    )
      return { connected: true, events: [] };
    return { connected: !result.noCalendarConnected, events: result.events };
  } catch (error) {
    // Unknown isn't "not connected": don't ask a connected user to connect.
    logger.warn("Failed to fetch calendar events for Today", { error });
    return { connected: true, events: [] };
  }
}

async function isNewMailbox({
  emailAccountId,
  now,
}: {
  emailAccountId: string;
  now: Date;
}) {
  const mailbox = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { createdAt: true },
  });
  return (
    !!mailbox &&
    now.getTime() - mailbox.createdAt.getTime() < SIGN_IN_CALENDAR_GRACE_MS
  );
}

/**
 * Work due soon in the user's connected apps. Each app is cached for a few
 * minutes; one that's slow is left out of this answer but still fills the
 * cache when it finishes, so the next visit has it.
 */
async function getDeadlines({
  emailAccountId,
  now,
  windowEnd,
  timeZone,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  windowEnd: Date;
  timeZone: string;
  logger: Logger;
}): Promise<{ connected: boolean; items: NextUpItem[] }> {
  const connections = await prisma.mcpConnection
    .findMany({
      where: {
        isActive: true,
        integration: { name: { in: Object.keys(DEADLINE_SOURCES) } },
        ...ownedBySameUser(emailAccountId),
      },
      select: {
        id: true,
        needsReconnectAt: true,
        emailAccountId: true,
        emailAccount: { select: { email: true } },
        integration: { select: { name: true } },
      },
      orderBy: { createdAt: "asc" },
    })
    .catch((error) => {
      logger.warn("Failed to load connected apps for Today", { error });
      return null;
    });
  // Unknown isn't "none": don't suggest connecting what may be connected.
  if (!connections) return { connected: true, items: [] };

  const results = await Promise.all(
    onePerIntegration(connections, emailAccountId).map(async (connection) => {
      const app = connection.integration.name;
      const source = DEADLINE_SOURCES[app];
      // Still connected, so nothing to suggest, but the app turned its
      // credentials away: Integrations asks the person to reconnect it.
      if (!source || !connection.emailAccountId || connection.needsReconnectAt)
        return [];
      const accountId = connection.emailAccountId;
      const execute: Execute | null = connectionExecutor({
        id: connection.id,
        integrationName: app,
        emailAccountId: accountId,
      });
      if (!execute) return [];
      const inWindow = (items: NextUpItem[]) =>
        items.filter(
          (item) => new Date(item.at) > now && new Date(item.at) < windowEnd,
        );

      // Only a pause is kept: the items name the user's own tasks, so they
      // go to the browser and never into the server cache (RD-3).
      const pausedKey = `home-deadlines-paused:${app}:${accountId}`;
      if (await redis.get(pausedKey).catch(() => null)) return [];

      const skipForAWhile = () =>
        redis
          .set(pausedKey, "1", { ex: DEADLINE_PAUSE_SECONDS })
          .catch(() => null);

      const fetching = source
        .fetch(execute, {
          accountId,
          accountEmail: connection.emailAccount?.email ?? "",
          now,
          windowEnd,
          timeZone,
        })
        .catch(async (error) => {
          // An app that's down stays down for a while: asking on every
          // visit only waits on the same failure.
          if (isAppServerError(error)) await skipForAWhile();
          throw error;
        });
      try {
        return inWindow(await withTimeout(fetching, SOURCE_TIMEOUT_MS));
      } catch (error) {
        if (error instanceof TimeoutError) {
          logger.warn("Connected app timed out", { app });
          // A slow app is as slow on the next visit.
          await skipForAWhile();
        } else if (isAppServerError(error)) {
          logger.trace("Connected app down for deadlines", { app });
        } else {
          logger.warn("Connected app deadlines failed", { app, error });
        }
        return [];
      }
    }),
  );
  return { connected: connections.length > 0, items: results.flat() };
}

/**
 * One app worth connecting, chosen from who the user gets mail from: a
 * student with mail from Canvas's domain is offered Canvas.
 */
async function connectSuggestion({
  emailAccountId,
  now,
  logger,
}: {
  emailAccountId: string;
  now: Date;
  logger: Logger;
}): Promise<{ app: string; name: string } | null> {
  if (!getIntegrationProvider("composio").isConfigured()) return null;
  const domains = Object.values(DEADLINE_SOURCES).flatMap((s) => s.domains);
  const senders = await prisma.emailMessage
    .findMany({
      where: {
        emailAccountId,
        sent: false,
        date: { gte: addDays(now, -SUGGESTION_WINDOW_DAYS) },
        OR: domains.flatMap((domain) => [
          { fromDomain: domain },
          { fromDomain: { endsWith: `.${domain}` } },
        ]),
      },
      select: { fromDomain: true },
      distinct: ["fromDomain"],
      take: 20,
    })
    .catch((error) => {
      logger.warn("Failed to read senders for a Today suggestion", { error });
      return [];
    });
  const app = Object.keys(DEADLINE_SOURCES).find((name) =>
    senders.some(({ fromDomain }) =>
      DEADLINE_SOURCES[name].domains.some(
        (domain) =>
          fromDomain.toLowerCase() === domain ||
          fromDomain.toLowerCase().endsWith(`.${domain}`),
      ),
    ),
  );
  const integration = app ? findIntegration(app) : undefined;
  return app && integration ? { app, name: integration.displayName } : null;
}

/** Assignments due soon, from the Canvas calendar of the student's courses. */
async function canvasDeadlines(
  execute: Execute,
  { accountId, now }: SourceContext,
): Promise<NextUpItem[]> {
  const assignments = await searchCanvas(execute, {
    emailAccountId: accountId,
    keywords: [],
    now,
  });
  return assignments.flatMap((assignment) => {
    const at = new Date(assignment.at);
    if (Number.isNaN(at.getTime())) return [];
    return [
      {
        id: assignment.id,
        kind: "deadline" as const,
        title: assignment.title,
        // Canvas's own format; times are compared as ISO strings.
        at: at.toISOString(),
        source: "Canvas",
        detail: assignment.source !== "Canvas" ? assignment.source : undefined,
        url: assignment.url,
      },
    ];
  });
}

/** Open Jira issues assigned to the user with a due date this week. */
async function jiraDeadlines(
  execute: Execute,
  { timeZone }: SourceContext,
): Promise<NextUpItem[]> {
  const { issues } = parseToolResult(
    "JIRA_SEARCH_ISSUES",
    jiraSearchSchema,
    await execute("JIRA_SEARCH_ISSUES", {
      jql: `assignee = currentUser() AND statusCategory != Done AND duedate >= startOfDay() AND duedate <= endOfDay("+${DEADLINE_WINDOW_DAYS}d") ORDER BY duedate ASC`,
      fields: ["summary", "duedate"],
      max_results: 10,
    }),
  );
  return issues.flatMap((issue) => {
    const at = issue.fields.duedate
      ? endOfDate(issue.fields.duedate, timeZone)
      : null;
    if (!at) return [];
    // Only a site's own address can be linked; OAuth answers through
    // api.atlassian.com, which has no page for the issue.
    const site = issue.self ? safeUrl(issue.self) : null;
    return [
      {
        id: `jira:${issue.key}`,
        kind: "deadline" as const,
        title: `${issue.key} ${issue.fields.summary}`,
        at,
        allDay: true,
        source: "Jira",
        url: site?.hostname.endsWith(".atlassian.net")
          ? `${site.origin}/browse/${issue.key}`
          : undefined,
      },
    ];
  });
}

/** Incomplete tasks in the user's My Tasks list with a due date. */
async function asanaDeadlines(
  execute: Execute,
  { accountId, timeZone }: SourceContext,
): Promise<NextUpItem[]> {
  const taskList = await asanaTaskListGid(execute, accountId);
  if (!taskList) return [];
  const { data } = parseToolResult(
    "ASANA_GET_TASKS_FOR_USER_TASK_LIST",
    asanaTasksSchema,
    await execute("ASANA_GET_TASKS_FOR_USER_TASK_LIST", {
      user_task_list_gid: taskList,
      completed_since: "now",
      opt_fields: ["name", "due_on", "due_at", "permalink_url"],
      limit: 100,
    }),
  );
  return data.flatMap((task) => {
    const at = task.due_at
      ? new Date(task.due_at).toISOString()
      : task.due_on
        ? endOfDate(task.due_on, timeZone)
        : null;
    if (!at) return [];
    return [
      {
        id: `asana:${task.gid}`,
        kind: "deadline" as const,
        title: task.name,
        at,
        allDay: !task.due_at,
        source: "Asana",
        url: task.permalink_url ?? undefined,
      },
    ];
  });
}

/** The user's My Tasks list in their first workspace, cached: it never changes. */
async function asanaTaskListGid(execute: Execute, accountId: string) {
  const key = `asana-task-list:${accountId}`;
  const cached = await redis.get<string>(key).catch(() => null);
  if (cached) return cached;
  const workspaces = parseToolResult(
    "ASANA_GET_MULTIPLE_WORKSPACES",
    asanaListSchema,
    await execute("ASANA_GET_MULTIPLE_WORKSPACES", { limit: 10 }),
  );
  const workspace = workspaces.data[0]?.gid;
  if (!workspace) return null;
  const { data } = parseToolResult(
    "ASANA_GET_A_USER_TASK_LIST",
    asanaTaskListSchema,
    await execute("ASANA_GET_A_USER_TASK_LIST", {
      user_task_list_gid: "me",
      workspace,
    }),
  );
  await redis
    .set(key, data.gid, { ex: TASK_LIST_CACHE_SECONDS })
    .catch(() => null);
  return data.gid;
}

/**
 * Open ClickUp tasks assigned to the user and due this week. ClickUp filters
 * by member id, found by the address the app was connected with.
 */
async function clickUpDeadlines(
  execute: Execute,
  { accountEmail, now, windowEnd }: SourceContext,
): Promise<NextUpItem[]> {
  const { teams } = parseToolResult(
    "CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES",
    clickUpTeamsSchema,
    await execute("CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES", {}),
  );
  const email = accountEmail.toLowerCase();
  const team = teams
    .map((t) => ({
      id: t.id,
      userId: t.members?.find((m) => m.user?.email?.toLowerCase() === email)
        ?.user?.id,
    }))
    .find((t) => t.userId !== undefined);
  if (!team) return [];
  const { tasks } = parseToolResult(
    "CLICKUP_GET_FILTERED_TEAM_TASKS",
    clickUpTasksSchema,
    await execute("CLICKUP_GET_FILTERED_TEAM_TASKS", {
      team_Id: team.id,
      assignees: [String(team.userId)],
      due_date_gt: now.getTime(),
      due_date_lt: windowEnd.getTime(),
      order_by: "due_date",
    }),
  );
  return tasks.flatMap((task) => {
    const due = task.due_date ? new Date(Number(task.due_date)) : null;
    if (!due || Number.isNaN(due.getTime())) return [];
    return [
      {
        id: `clickup:${task.id}`,
        kind: "deadline" as const,
        title: task.name,
        at: due.toISOString(),
        allDay: task.due_date_time === false,
        source: "ClickUp",
        url: task.url ?? undefined,
      },
    ];
  });
}

function eventItem(event: CalendarEvent, labelCalendar: boolean): NextUpItem {
  return {
    id: `event:${event.id}`,
    kind: "event",
    title: event.title,
    at: event.startTime.toISOString(),
    endAt: event.endTime.toISOString(),
    source: "Calendar",
    ...(labelCalendar && event.calendarEmail
      ? { detail: event.calendarEmail }
      : {}),
    url: event.eventUrl,
  };
}

function distinctCalendars(accounts: { email: string }[]) {
  return new Set(accounts.map((account) => account.email.toLowerCase())).size;
}

/** The last minute of a `YYYY-MM-DD` date in the user's time zone. */
function endOfDate(date: string, timeZone: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [, year, month, day] = match;
  return new TZDate(
    Number(year),
    Number(month) - 1,
    Number(day),
    23,
    59,
    0,
    timeZone,
  ).toISOString();
}

function safeUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

// Apps return their own API's JSON; only the fields used here are checked.
const jiraSearchSchema = z.object({
  issues: z.array(
    z.object({
      key: z.string(),
      self: z.string().nullish(),
      fields: z.object({
        summary: z.string(),
        duedate: z.string().nullish(),
      }),
    }),
  ),
});

const asanaListSchema = z.object({
  data: z.array(z.object({ gid: z.string() })),
});

const asanaTaskListSchema = z.object({ data: z.object({ gid: z.string() }) });

const asanaTasksSchema = z.object({
  data: z.array(
    z.object({
      gid: z.string(),
      name: z.string(),
      due_on: z.string().nullish(),
      due_at: z.string().nullish(),
      permalink_url: z.string().nullish(),
    }),
  ),
});

const clickUpTeamsSchema = z.object({
  teams: z.array(
    z.object({
      id: z.string(),
      members: z
        .array(
          z.object({
            user: z
              .object({
                id: z.union([z.number(), z.string()]),
                email: z.string().nullish(),
              })
              .nullish(),
          }),
        )
        .nullish(),
    }),
  ),
});

const clickUpTasksSchema = z.object({
  tasks: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      url: z.string().nullish(),
      due_date: z.string().nullish(),
      due_date_time: z.boolean().nullish(),
    }),
  ),
});

/**
 * The one meeting Today names as next, from events still to come. Late in
 * the day, what's left tonight matters less than how tomorrow starts; and
 * once today's meetings are over, tomorrow's first one is still worth knowing
 * on a quiet afternoon.
 */
function pickNextEvent<T extends Pick<CalendarEvent, "startTime">>(
  events: T[],
  { now, today, timeZone }: { now: Date; today: Date; timeZone: string },
): { event: T; tomorrow: boolean } | null {
  const tomorrow = addDays(today, 1);
  const dayAfter = addDays(today, 2);
  const upcoming = [...events].sort(
    (a, b) => a.startTime.getTime() - b.startTime.getTime(),
  );
  const tomorrowFirst = upcoming.find(
    (event) => event.startTime >= tomorrow && event.startTime < dayAfter,
  );
  const evening = new TZDate(now, timeZone).getHours() >= EVENING_HOUR;
  const laterToday = evening
    ? undefined
    : upcoming.find((event) => event.startTime < tomorrow);
  if (laterToday) return { event: laterToday, tomorrow: false };
  return tomorrowFirst ? { event: tomorrowFirst, tomorrow: true } : null;
}
