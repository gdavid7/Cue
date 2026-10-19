import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { MeetingBriefingStatus } from "@/generated/prisma/enums";
import {
  CRON_INTERVAL_MINUTES,
  fetchUpcomingEvents,
  filterEventsWithExternalGuests,
} from "./fetch-upcoming-events";
import { gatherContextForEvent } from "./gather-context";
import { aiGenerateMeetingBriefing } from "@/utils/ai/meeting-briefs/generate-briefing";
import { sendBriefing } from "./send-briefing";
import type { Logger } from "@/utils/logger";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { partitionAttendeesForBriefing } from "./attendees";
import { getUserOwnAddresses } from "@/utils/user/own-addresses";
import { canonicalizeEmailAddress } from "@/utils/email";
import { mapWithConcurrency } from "@/utils/async";

export type EmailAccountForBrief = {
  id: string;
  userId: string;
  email: string;
  about: string | null;
  multiRuleSelectionEnabled: boolean;
  sensitiveDataPolicy: string | null;
  timezone: string | null;
  calendarBookingLink: string | null;
  user: {
    aiProvider: string | null;
    aiModel: string | null;
    aiApiKey: string | null;
  };
  account: {
    provider: string;
  };
};

// A claim still pending this long belongs to a run that died: the cron's
// maxDuration (300s, app/api/meeting-briefs/route.ts) plus a minute.
const STALLED_PENDING_MS = (300 + 60) * 1000;
const CALENDAR_FETCH_CONCURRENCY = 3;

type BriefAccount = {
  id: string;
  email: string;
  meetingBriefingsMinutesBefore: number;
};

type MeetingCopy = { emailAccountId: string; event: CalendarEvent };

/**
 * Briefs one person's mailboxes together. A meeting on several of their
 * calendars has a different event id on each and is briefed from one copy.
 * Every rule errs toward a duplicate brief, never toward none.
 */
export async function processUserMeetingBriefings({
  userId,
  emailAccounts,
  logger,
}: {
  userId: string;
  emailAccounts: BriefAccount[];
  logger: Logger;
}): Promise<{ emailAccountId: string; error?: unknown }[]> {
  // Mailboxes run in the order copies are chosen, so a chosen copy is tried
  // before any copy that would take over from it.
  const accounts = [...emailAccounts].sort((a, b) => compareIds(a.id, b.id));
  const ownAddresses = await getUserOwnAddresses(userId);

  const fetched = await mapWithConcurrency(
    accounts,
    CALENDAR_FETCH_CONCURRENCY,
    async (account) => {
      try {
        const events = await fetchUpcomingEvents({
          emailAccountId: account.id,
          minutesBefore: account.meetingBriefingsMinutesBefore,
          logger: accountLogger(logger, account),
        });
        // Only a copy its own mailbox would brief can be chosen, so a
        // placeholder without guests never holds the meeting back.
        return {
          account,
          events: filterEventsWithExternalGuests(
            events,
            account.email,
            ownAddresses,
          ),
        };
      } catch (error) {
        return { account, events: [], error };
      }
    },
  );

  const copies = fetched.flatMap(({ account, events }) =>
    events.map((event) => ({ emailAccountId: account.id, event })),
  );

  const results: { emailAccountId: string; error?: unknown }[] = [];
  for (const { account, events, error } of fetched) {
    if (error) {
      results.push({ emailAccountId: account.id, error });
      continue;
    }
    try {
      await processAccountMeetingBriefings({
        userId,
        account,
        events,
        copies,
        ownAddresses,
        logger: accountLogger(logger, account),
      });
      results.push({ emailAccountId: account.id });
    } catch (error) {
      results.push({ emailAccountId: account.id, error });
    }
  }
  return results;
}

async function processAccountMeetingBriefings({
  userId,
  account,
  events,
  copies,
  ownAddresses,
  logger,
}: {
  userId: string;
  account: BriefAccount;
  events: CalendarEvent[];
  copies: MeetingCopy[];
  ownAddresses: string[];
  logger: Logger;
}) {
  logger.info("Processing meeting briefings", {
    minutesBefore: account.meetingBriefingsMinutesBefore,
    count: events.length,
  });

  if (events.length === 0) {
    logger.info("No events with external guests, skipping");
    return;
  }

  const existingBriefings = await prisma.meetingBriefing.findMany({
    where: {
      emailAccountId: account.id,
      calendarEventId: { in: events.map((e) => e.id) },
    },
    select: { calendarEventId: true },
  });

  const briefedEventIds = new Set(
    existingBriefings.map((b) => b.calendarEventId),
  );
  const eventsToProcess = events
    .filter((event) => !briefedEventIds.has(event.id))
    .sort((a, b) => compareIds(a.id, b.id));

  if (eventsToProcess.length === 0) {
    logger.info("All events already briefed, skipping");
    return;
  }

  // Get full email account for AI generation
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: account.id, userId },
    select: {
      id: true,
      userId: true,
      email: true,
      about: true,
      multiRuleSelectionEnabled: true,
      sensitiveDataPolicy: true,
      timezone: true,
      calendarBookingLink: true,
      user: {
        select: {
          aiProvider: true,
          aiModel: true,
          aiApiKey: true,
        },
      },
      account: {
        select: {
          provider: true,
        },
      },
    },
  });

  if (!emailAccount) {
    logger.error("Email account not found");
    return;
  }

  for (const event of eventsToProcess) {
    const eventLog = logger.with({ eventId: event.id });
    const decision = await decideMeetingCopy({
      userId,
      copy: { emailAccountId: account.id, event },
      copies,
    });

    if (decision === "wait") {
      eventLog.info("Another copy of this meeting is being briefed, waiting");
      continue;
    }

    if (decision === "skip") {
      eventLog.info("Meeting already briefed from another copy, skipping");
      await upsertMeetingBriefingStatus({
        emailAccountId: account.id,
        calendarEventId: event.id,
        eventTitle: event.title,
        eventStartTime: event.startTime,
        guestCount: partitionAttendeesForBriefing(
          event,
          account.email,
          ownAddresses,
        ).external.length,
        status: MeetingBriefingStatus.SKIPPED,
        logger: eventLog,
      });
      continue;
    }

    try {
      await runMeetingBrief({
        event,
        emailAccount,
        emailAccountId: account.id,
        isTestSend: false,
        logger,
      });
    } catch {
      // Error already logged and saved by runMeetingBrief
    }
  }

  logger.info("Finished processing meeting briefings");
}

/**
 * Copies of one meeting are ordered the same way by every mailbox: lowest
 * mailbox id, then lowest event id. The first copy that can still be briefed
 * briefs the meeting. An earlier copy is passed over when its brief failed or
 * stalled, or when it is still unclaimed with no cron tick left before the
 * meeting: mailboxes run in this order, so it was not going to be briefed.
 * Copies wait while an earlier one may still be briefed, and are skipped
 * only once some copy has been sent.
 */
async function decideMeetingCopy({
  userId,
  copy,
  copies,
}: {
  userId: string;
  copy: MeetingCopy;
  copies: MeetingCopy[];
}): Promise<"brief" | "wait" | "skip"> {
  const otherCopies = copies
    .filter(
      (other) =>
        !(
          other.emailAccountId === copy.emailAccountId &&
          other.event.id === copy.event.id
        ) && isSameMeeting(copy.event, other.event),
    )
    .sort(compareCopies);

  if (otherCopies.length === 0) return "brief";

  const briefings = await prisma.meetingBriefing.findMany({
    where: {
      emailAccount: { userId },
      OR: otherCopies.map((other) => ({
        emailAccountId: other.emailAccountId,
        calendarEventId: other.event.id,
      })),
    },
    select: {
      emailAccountId: true,
      calendarEventId: true,
      status: true,
      createdAt: true,
    },
  });

  if (briefings.some((b) => b.status === MeetingBriefingStatus.SENT)) {
    return "skip";
  }

  const now = Date.now();
  for (const other of otherCopies) {
    if (compareCopies(other, copy) > 0) break;

    const briefing = briefings.find(
      (b) =>
        b.emailAccountId === other.emailAccountId &&
        b.calendarEventId === other.event.id,
    );

    if (!briefing) {
      const untilStart = other.event.startTime.getTime() - now;
      if (untilStart > CRON_INTERVAL_MINUTES * 60_000) return "wait";
      continue;
    }

    if (
      briefing.status === MeetingBriefingStatus.PENDING &&
      now - briefing.createdAt.getTime() < STALLED_PENDING_MS
    ) {
      return "wait";
    }
  }

  return "brief";
}

export async function runMeetingBrief({
  event,
  emailAccount,
  emailAccountId,
  logger,
  isTestSend,
}: {
  event: CalendarEvent;
  emailAccount: EmailAccountForBrief;
  emailAccountId: string;
  logger: Logger;
  isTestSend: boolean;
}): Promise<{ success: boolean; message?: string }> {
  const userEmail = emailAccount.email;
  const provider = emailAccount.account.provider;

  const eventLog = logger.with({ eventId: event.id });

  const { external: externalAttendees, internal: internalAttendees } =
    partitionAttendeesForBriefing(
      event,
      userEmail,
      await getUserOwnAddresses(emailAccount.userId),
    );
  const externalGuestCount = externalAttendees.length;

  if (!isTestSend) {
    const claimed = await claimMeetingBriefing({
      emailAccountId,
      calendarEventId: event.id,
      eventTitle: event.title,
      eventStartTime: event.startTime,
      guestCount: externalGuestCount,
    });

    if (!claimed) {
      eventLog.info("Event already claimed by another process, skipping");
      return { success: false, message: "Already being processed" };
    }
  }

  try {
    const briefingData = await gatherContextForEvent({
      event,
      emailAccountId,
      externalAttendees,
      internalAttendees,
      provider,
      logger: eventLog,
    });

    if (briefingData.externalGuests.length === 0) {
      eventLog.info("No external guests found for event, skipping");
      if (!isTestSend) {
        await upsertMeetingBriefingStatus({
          emailAccountId,
          calendarEventId: event.id,
          eventTitle: event.title,
          eventStartTime: event.startTime,
          guestCount: externalGuestCount,
          status: MeetingBriefingStatus.SKIPPED,
          logger: eventLog,
        });
      }
      return { success: false, message: "No external guests found" };
    }

    const briefingContent = await aiGenerateMeetingBriefing({
      briefingData,
      emailAccount,
      logger: eventLog,
    });

    await sendBriefing({
      event,
      briefingContent,
      internalTeamMembers: briefingData.internalTeamMembers,
      emailAccountId,
      userEmail,
      provider,
      userTimezone: emailAccount.timezone,
      logger: eventLog,
    });

    if (!isTestSend) {
      await upsertMeetingBriefingStatus({
        emailAccountId,
        calendarEventId: event.id,
        eventTitle: event.title,
        eventStartTime: event.startTime,
        guestCount: externalGuestCount,
        status: MeetingBriefingStatus.SENT,
        logger: eventLog,
      });
    }

    eventLog.info("Meeting briefing sent successfully");
    return { success: true, message: "Brief sent successfully" };
  } catch (error) {
    eventLog.error("Failed to process meeting briefing", { error });

    if (!isTestSend) {
      await upsertMeetingBriefingStatus({
        emailAccountId,
        calendarEventId: event.id,
        eventTitle: event.title,
        eventStartTime: event.startTime,
        guestCount: externalGuestCount,
        status: MeetingBriefingStatus.FAILED,
        logger: eventLog,
      });
    }

    throw error;
  }
}

async function claimMeetingBriefing({
  emailAccountId,
  calendarEventId,
  eventTitle,
  eventStartTime,
  guestCount,
}: {
  emailAccountId: string;
  calendarEventId: string;
  eventTitle: string;
  eventStartTime: Date;
  guestCount: number;
}): Promise<boolean> {
  try {
    await prisma.meetingBriefing.create({
      data: {
        emailAccountId,
        calendarEventId,
        eventTitle,
        eventStartTime,
        guestCount,
        status: MeetingBriefingStatus.PENDING,
      },
    });
    return true;
  } catch (error) {
    if (isDuplicateError(error)) {
      return false;
    }
    throw error;
  }
}

async function upsertMeetingBriefingStatus({
  emailAccountId,
  calendarEventId,
  eventTitle,
  eventStartTime,
  guestCount,
  status,
  logger,
}: {
  emailAccountId: string;
  calendarEventId: string;
  eventTitle: string;
  eventStartTime: Date;
  guestCount: number;
  status: MeetingBriefingStatus;
  logger: Logger;
}): Promise<void> {
  try {
    await prisma.meetingBriefing.upsert({
      where: {
        emailAccountId_calendarEventId: {
          emailAccountId,
          calendarEventId,
        },
      },
      create: {
        emailAccountId,
        calendarEventId,
        eventTitle,
        eventStartTime,
        guestCount,
        status,
      },
      update: { status },
    });
  } catch (error) {
    logger.error("Failed to upsert meeting briefing status", { error, status });
  }
}

function accountLogger(logger: Logger, account: BriefAccount) {
  return logger.with({ emailAccountId: account.id, email: account.email });
}

/**
 * Two copies are one meeting when title, start and end match and, where both
 * list attendees, they share one, so two different meetings that happen to
 * share a name and time are each briefed.
 */
function isSameMeeting(a: CalendarEvent, b: CalendarEvent) {
  if (
    a.title.trim() !== b.title.trim() ||
    a.startTime.getTime() !== b.startTime.getTime() ||
    a.endTime.getTime() !== b.endTime.getTime()
  ) {
    return false;
  }
  if (a.attendees.length === 0 || b.attendees.length === 0) return true;
  const attendees = new Set(
    a.attendees.map((attendee) => canonicalizeEmailAddress(attendee.email)),
  );
  return b.attendees.some((attendee) =>
    attendees.has(canonicalizeEmailAddress(attendee.email)),
  );
}

function compareCopies(a: MeetingCopy, b: MeetingCopy) {
  return (
    compareIds(a.emailAccountId, b.emailAccountId) ||
    compareIds(a.event.id, b.event.id)
  );
}

function compareIds(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
