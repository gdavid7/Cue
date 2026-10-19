import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { MeetingBriefingStatus } from "@/generated/prisma/enums";
import {
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
import { getPremiumUserFilter } from "@/utils/premium";
import { chooseBriefedCopy } from "./same-meeting";

// A brief claimed this long ago and still pending is taken to have stalled,
// so another of the user's calendars may brief the meeting instead.
const STALLED_BRIEF_MS = 15 * 60_000;

/** Accounts the meeting-brief cron briefs. */
export function meetingBriefAccountsWhere() {
  return {
    meetingBriefingsEnabled: true,
    ...getPremiumUserFilter(),
    // Must have a calendar connected
    calendarConnections: { some: { isConnected: true } },
  };
}

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

export async function processMeetingBriefings({
  emailAccountId,
  userEmail,
  minutesBefore,
  logger,
}: {
  emailAccountId: string;
  userEmail: string;
  minutesBefore: number;
  logger: Logger;
}): Promise<void> {
  logger.info("Processing meeting briefings", { minutesBefore });

  // 1. Fetch upcoming events
  const allEvents = await fetchUpcomingEvents({
    emailAccountId,
    minutesBefore,
    logger,
  });

  logger.info("Fetched upcoming events", { count: allEvents.length });

  if (allEvents.length === 0) {
    logger.info("No events with external guests, skipping");
    return;
  }

  // Get full email account for AI generation
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
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

  // 2. Filter to events with external guests
  const eventsWithExternalGuests = filterEventsWithExternalGuests(
    allEvents,
    userEmail,
    await getUserOwnAddresses(emailAccount.userId),
  );

  if (eventsWithExternalGuests.length === 0) {
    logger.info("No events with external guests, skipping");
    return;
  }

  // 3. Check which events haven't been briefed yet
  const existingBriefings = await prisma.meetingBriefing.findMany({
    where: {
      emailAccountId,
      calendarEventId: {
        in: eventsWithExternalGuests.map((e) => e.id),
      },
    },
    select: { calendarEventId: true },
  });

  const briefedEventIds = new Set(
    existingBriefings.map((b) => b.calendarEventId),
  );
  const eventsToProcess = eventsWithExternalGuests.filter(
    (event) => !briefedEventIds.has(event.id),
  );

  if (eventsToProcess.length === 0) {
    logger.info("All events already briefed, skipping");
    return;
  }

  const otherAccountsEvents = await fetchOtherAccountsEvents({
    userId: emailAccount.userId,
    emailAccountId,
    minutesBefore,
    logger,
  });

  // 4. Process each event
  for (const event of eventsToProcess) {
    const briefedCopy = chooseBriefedCopy(event, emailAccountId, [
      { emailAccountId, events: allEvents },
      ...otherAccountsEvents,
    ]);
    if (
      briefedCopy.eventId !== event.id &&
      !(await shouldBriefInsteadOf({
        briefedCopy,
        emailAccountId,
        event,
        logger,
      }))
    ) {
      continue;
    }
    try {
      await runMeetingBrief({
        event,
        emailAccount,
        emailAccountId,
        isTestSend: false,
        logger,
      });
    } catch {
      // Error already logged and saved by runMeetingBrief
    }
  }

  logger.info("Finished processing meeting briefings");
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

/**
 * The same window of the user's other briefed mailboxes' calendars, so a
 * meeting on several of them is briefed once.
 */
async function fetchOtherAccountsEvents({
  userId,
  emailAccountId,
  minutesBefore,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  minutesBefore: number;
  logger: Logger;
}) {
  const others = await prisma.emailAccount.findMany({
    where: {
      ...meetingBriefAccountsWhere(),
      userId,
      id: { not: emailAccountId },
    },
    select: { id: true },
  });
  return Promise.all(
    others.map(async (other) => ({
      emailAccountId: other.id,
      events: await fetchUpcomingEvents({
        emailAccountId: other.id,
        minutesBefore,
        logger: logger.with({ otherEmailAccountId: other.id }),
      }).catch(() => []),
    })),
  );
}

/**
 * Another copy of this meeting is the one to brief. This copy waits while
 * that one is unclaimed or recently claimed, is put away once that one is
 * sent, and is briefed itself if that one failed or stalled.
 */
async function shouldBriefInsteadOf({
  briefedCopy,
  emailAccountId,
  event,
  logger,
}: {
  briefedCopy: { emailAccountId: string; eventId: string };
  emailAccountId: string;
  event: CalendarEvent;
  logger: Logger;
}) {
  // A second copy on this mailbox's own calendars is never briefed.
  if (briefedCopy.emailAccountId === emailAccountId) return false;
  const briefing = await prisma.meetingBriefing.findUnique({
    where: {
      emailAccountId_calendarEventId: {
        emailAccountId: briefedCopy.emailAccountId,
        calendarEventId: briefedCopy.eventId,
      },
    },
    select: { status: true, createdAt: true },
  });
  if (briefing?.status === MeetingBriefingStatus.SENT) {
    logger.info("Meeting briefed from another calendar, skipping");
    await upsertMeetingBriefingStatus({
      emailAccountId,
      calendarEventId: event.id,
      eventTitle: event.title,
      eventStartTime: event.startTime,
      guestCount: 0,
      status: MeetingBriefingStatus.SKIPPED,
      logger,
    });
    return false;
  }
  if (!briefing) return false;
  if (
    briefing.status === MeetingBriefingStatus.PENDING &&
    Date.now() - briefing.createdAt.getTime() < STALLED_BRIEF_MS
  ) {
    return false;
  }
  return true;
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
