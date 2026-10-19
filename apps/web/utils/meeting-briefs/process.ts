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
import uniqBy from "lodash/uniqBy";

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
// A copy only waits while at least two more ticks are due before the
// meeting, so one late or missed tick cannot leave it unbriefed.
const MIN_WAIT_LEAD_MS = 2 * CRON_INTERVAL_MINUTES * 60_000;
const CALENDAR_FETCH_CONCURRENCY = 3;
const MEETING_CONCURRENCY = 3;

type BriefAccount = {
  id: string;
  email: string;
  meetingBriefingsMinutesBefore: number;
};

type MeetingCopy = {
  account: BriefAccount;
  event: CalendarEvent;
  externalGuests: Set<string>;
};

/**
 * Briefs one person's mailboxes together. A meeting on several of their
 * calendars has a different event id on each and is briefed from one copy.
 * Every rule errs toward a duplicate brief, never toward none.
 *
 * Different meetings run in parallel; the copies of one meeting run in order,
 * so a copy decides only after every earlier copy has had its turn. No brief
 * is started after `deadline`, leaving it unclaimed for the next tick rather
 * than cut off mid-way.
 */
export async function processUserMeetingBriefings({
  userId,
  emailAccounts,
  deadline,
  logger,
}: {
  userId: string;
  emailAccounts: BriefAccount[];
  deadline: Date;
  logger: Logger;
}): Promise<{ emailAccountId: string; error?: unknown }[]> {
  const errors = new Map<string, unknown>();
  const ownAddresses = await getUserOwnAddresses(userId);

  const fetched = await mapWithConcurrency(
    emailAccounts,
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
        return filterEventsWithExternalGuests(
          events,
          account.email,
          ownAddresses,
        ).map((event) => ({
          account,
          event,
          externalGuests: new Set(
            partitionAttendeesForBriefing(
              event,
              account.email,
              ownAddresses,
            ).external.map((guest) => canonicalizeEmailAddress(guest.email)),
          ),
        }));
      } catch (error) {
        errors.set(account.id, error);
        return [];
      }
    },
  );

  const copies = uniqBy(fetched.flat(), copyKey);

  const existing =
    copies.length > 0
      ? await prisma.meetingBriefing.findMany({
          where: { emailAccount: { userId }, OR: copies.map(copyWhere) },
          select: { emailAccountId: true, calendarEventId: true },
        })
      : [];
  const claimed = new Set(
    existing.map((b) => `${b.emailAccountId}:${b.calendarEventId}`),
  );

  const accounts = new Map<string, Promise<EmailAccountForBrief | null>>();
  const loadAccount = (id: string) => {
    let account = accounts.get(id);
    if (!account) {
      account = loadEmailAccountForBrief(id, userId);
      accounts.set(id, account);
    }
    return account;
  };

  await mapWithConcurrency(
    groupSameMeetings(copies),
    MEETING_CONCURRENCY,
    async (meeting) => {
      for (const copy of meeting) {
        if (claimed.has(copyKey(copy))) continue;
        const copyLog = accountLogger(logger, copy.account).with({
          eventId: copy.event.id,
        });
        if (Date.now() >= deadline.getTime()) {
          copyLog.info("Out of time this run, leaving brief for next tick");
          return;
        }
        try {
          await processMeetingCopy({
            userId,
            copy,
            meeting,
            loadAccount,
            logger: copyLog,
          });
        } catch (error) {
          errors.set(copy.account.id, error);
        }
      }
    },
  );

  return emailAccounts.map((account) => ({
    emailAccountId: account.id,
    error: errors.get(account.id),
  }));
}

async function processMeetingCopy({
  userId,
  copy,
  meeting,
  loadAccount,
  logger,
}: {
  userId: string;
  copy: MeetingCopy;
  meeting: MeetingCopy[];
  loadAccount: (id: string) => Promise<EmailAccountForBrief | null>;
  logger: Logger;
}) {
  const decision = await decideMeetingCopy({ userId, copy, meeting });

  if (decision === "wait") {
    logger.info("Another copy of this meeting is being briefed, waiting");
    return;
  }

  if (decision === "skip") {
    logger.info("Meeting already briefed from another copy, skipping");
    await upsertMeetingBriefingStatus({
      emailAccountId: copy.account.id,
      calendarEventId: copy.event.id,
      eventTitle: copy.event.title,
      eventStartTime: copy.event.startTime,
      guestCount: copy.externalGuests.size,
      status: MeetingBriefingStatus.SKIPPED,
      logger,
    });
    return;
  }

  const emailAccount = await loadAccount(copy.account.id);
  if (!emailAccount) {
    logger.error("Email account not found");
    return;
  }

  try {
    await runMeetingBrief({
      event: copy.event,
      emailAccount,
      emailAccountId: copy.account.id,
      isTestSend: false,
      logger,
    });
  } catch {
    // Error already logged and saved by runMeetingBrief
  }
}

/**
 * Copies of one meeting are ordered the same way by every mailbox: lowest
 * mailbox id, then lowest event id, and run in that order. The first copy
 * that can still be briefed briefs the meeting, so when one fails only the
 * next takes over. An earlier copy that is unclaimed, failed or stalled has
 * already had its turn and is passed over. One claimed by another run moments
 * ago is waited on only while two more ticks are due before the meeting.
 * Copies are skipped only once some copy has been sent.
 */
async function decideMeetingCopy({
  userId,
  copy,
  meeting,
}: {
  userId: string;
  copy: MeetingCopy;
  meeting: MeetingCopy[];
}): Promise<"brief" | "wait" | "skip"> {
  const others = meeting.filter(
    (other) => copyKey(other) !== copyKey(copy) && isSameMeeting(copy, other),
  );
  if (others.length === 0) return "brief";

  const briefings = await prisma.meetingBriefing.findMany({
    where: { emailAccount: { userId }, OR: others.map(copyWhere) },
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
  if (copy.event.startTime.getTime() - now <= MIN_WAIT_LEAD_MS) return "brief";

  const earlierInFlight = briefings.some(
    (b) =>
      b.status === MeetingBriefingStatus.PENDING &&
      now - b.createdAt.getTime() < STALLED_PENDING_MS &&
      others.some(
        (other) =>
          other.account.id === b.emailAccountId &&
          other.event.id === b.calendarEventId &&
          compareCopies(other, copy) < 0,
      ),
  );
  return earlierInFlight ? "wait" : "brief";
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

  let externalGuestCount = 0;
  let claimed = false;

  try {
    const { external: externalAttendees, internal: internalAttendees } =
      partitionAttendeesForBriefing(
        event,
        userEmail,
        await getUserOwnAddresses(emailAccount.userId),
      );
    externalGuestCount = externalAttendees.length;

    if (!isTestSend) {
      claimed = await claimMeetingBriefing({
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

    // Unclaimed, the event stays open: this copy retries next tick and later
    // copies pass it over now.
    if (claimed) {
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

function loadEmailAccountForBrief(
  emailAccountId: string,
  userId: string,
): Promise<EmailAccountForBrief | null> {
  return prisma.emailAccount.findUnique({
    where: { id: emailAccountId, userId },
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
}

function accountLogger(logger: Logger, account: BriefAccount) {
  return logger.with({ emailAccountId: account.id, email: account.email });
}

/** Copies that are the same meeting, each group in copy order. */
function groupSameMeetings(copies: MeetingCopy[]) {
  let groups: MeetingCopy[][] = [];
  for (const copy of copies) {
    const joined = groups.filter((group) =>
      group.some((other) => isSameMeeting(copy, other)),
    );
    groups = groups.filter((group) => !joined.includes(group));
    groups.push([copy, ...joined.flat()].sort(compareCopies));
  }
  return groups;
}

/**
 * Two copies are one meeting when title, start and end match and they share
 * an external guest. Every copy has one, since only copies that would be
 * briefed are compared. A shared colleague or the user's own address is not
 * enough: back-to-back interview slots with one interviewer stay apart.
 */
function isSameMeeting(a: MeetingCopy, b: MeetingCopy) {
  if (
    a.event.title.trim() !== b.event.title.trim() ||
    a.event.startTime.getTime() !== b.event.startTime.getTime() ||
    a.event.endTime.getTime() !== b.event.endTime.getTime()
  ) {
    return false;
  }
  for (const guest of a.externalGuests) {
    if (b.externalGuests.has(guest)) return true;
  }
  return false;
}

function compareCopies(a: MeetingCopy, b: MeetingCopy) {
  return (
    compareIds(a.account.id, b.account.id) || compareIds(a.event.id, b.event.id)
  );
}

function compareIds(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function copyKey(copy: MeetingCopy) {
  return `${copy.account.id}:${copy.event.id}`;
}

function copyWhere(copy: MeetingCopy) {
  return { emailAccountId: copy.account.id, calendarEventId: copy.event.id };
}
