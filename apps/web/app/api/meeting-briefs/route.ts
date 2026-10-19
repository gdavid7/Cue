import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { getPremiumUserFilter } from "@/utils/premium";
import { processUserMeetingBriefings } from "@/utils/meeting-briefs/process";
import { mapWithConcurrency } from "@/utils/async";
import groupBy from "lodash/groupBy";

// STALLED_PENDING_MS in utils/meeting-briefs/process.ts is derived from this.
export const maxDuration = 300;
const MEETING_BRIEFING_USER_CONCURRENCY = 5;
// No brief starts after this, so none is cut off by maxDuration.
const BRIEF_START_BUDGET_MS = 240_000;

export const GET = withError("meeting-briefs", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/meeting-briefs"));
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await processAllMeetingBriefings(request.logger);

  return NextResponse.json(result);
});

export const POST = withError("meeting-briefs", async (request) => {
  if (!(await hasPostCronSecret(request))) {
    captureException(
      new Error("Unauthorized cron request: api/meeting-briefs"),
    );
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await processAllMeetingBriefings(request.logger);

  return NextResponse.json(result);
});

async function processAllMeetingBriefings(logger: Logger) {
  logger.info("Processing meeting briefings for all users");
  const deadline = new Date(Date.now() + BRIEF_START_BUDGET_MS);

  // Get all email accounts with meeting briefings enabled
  const emailAccounts = await prisma.emailAccount.findMany({
    where: {
      meetingBriefingsEnabled: true,
      ...getPremiumUserFilter(),
      // Must have a calendar connected
      calendarConnections: {
        some: {
          isConnected: true,
        },
      },
    },
    select: {
      id: true,
      userId: true,
      email: true,
      meetingBriefingsMinutesBefore: true,
    },
  });

  logger.info("Found eligible accounts", { count: emailAccounts.length });

  // A person's mailboxes are briefed together, so a meeting on several of
  // their calendars is briefed once.
  const users = Object.entries(groupBy(emailAccounts, (a) => a.userId));

  // A pool, not lock-step batches, so one heavy user holds up no one else.
  const results = await mapWithConcurrency(
    users,
    MEETING_BRIEFING_USER_CONCURRENCY,
    async ([userId, userAccounts]) => {
      try {
        return {
          userAccounts,
          accountResults: await processUserMeetingBriefings({
            userId,
            emailAccounts: userAccounts,
            deadline,
            logger,
          }),
        };
      } catch (error) {
        return {
          userAccounts,
          accountResults: userAccounts.map((a) => ({
            emailAccountId: a.id,
            error,
          })),
        };
      }
    },
  );

  let successCount = 0;
  let errorCount = 0;

  for (const { userAccounts, accountResults } of results) {
    for (const { emailAccountId, error } of accountResults) {
      if (!error) {
        successCount++;
        continue;
      }

      const emailAccount = userAccounts.find((a) => a.id === emailAccountId);
      logger
        .with({ emailAccountId, email: emailAccount?.email })
        .error("Failed to process meeting briefings for user", { error });
      captureException(error);
      errorCount++;
    }
  }

  logger.info("Completed processing meeting briefings", {
    total: emailAccounts.length,
    success: successCount,
    errors: errorCount,
  });

  return {
    total: emailAccounts.length,
    success: successCount,
    errors: errorCount,
  };
}
