import { processDueScheduledEmails } from "@/utils/scheduled-email/service";
import { NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { hasCronSecret, hasPostCronSecret, runCronJob } from "@/utils/cron";
import { captureException } from "@/utils/error";
import prisma from "@/utils/prisma";
import { ScheduledActionStatus } from "@/generated/prisma/enums";
import { createEmailProvider } from "@/utils/email/provider";
import {
  checkAndCompleteExecutedRule,
  executeScheduledAction,
} from "@/utils/scheduled-actions/executor";
import { markQStashActionAsExecuting } from "@/utils/scheduled-actions/scheduler";
import { recoverStaleScheduledActions } from "@/utils/scheduled-actions/recovery";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { processDueSnoozedThreads } from "@/utils/snooze/process-due";
import { recordFirstHourHealthForNewMailboxes } from "@/utils/analytics/first-hour-health";
import { hasTimeBeforeRequestDeadline } from "@/utils/request-deadline-reader";

export const maxDuration = 300;

const BATCH_SIZE = 100;
// Room for the action in progress to finish before the route is killed.
const ITEM_RESERVE_MS = 30_000;
export const GET = withError(
  "cron/scheduled-actions",
  async (request) => {
    if (!hasCronSecret(request)) {
      captureException(
        new Error("Unauthorized request: api/cron/scheduled-actions"),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    const result = await runScheduledWork(request.logger);

    return NextResponse.json(result);
  },
  { maxDuration },
);

export const POST = withError(
  "cron/scheduled-actions",
  async (request) => {
    if (!(await hasPostCronSecret(request))) {
      captureException(
        new Error("Unauthorized cron request: api/cron/scheduled-actions"),
      );
      return new Response("Unauthorized", { status: 401 });
    }

    const result = await runScheduledWork(request.logger);

    return NextResponse.json(result);
  },
  { maxDuration },
);

async function processScheduledActions(logger: Logger) {
  const now = new Date();

  const scheduledActions = await prisma.scheduledAction.findMany({
    where: {
      status: ScheduledActionStatus.PENDING,
      scheduledFor: { lte: now },
    },
    orderBy: { scheduledFor: "asc" },
    take: BATCH_SIZE,
    include: {
      emailAccount: {
        include: {
          account: true,
        },
      },
      executedRule: true,
    },
  });

  if (scheduledActions.length === 0) {
    return { processed: 0, failed: 0, skipped: 0, left: 0, total: 0 };
  }

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  let left = 0;

  for (const [index, scheduledAction] of scheduledActions.entries()) {
    if (!hasTimeBeforeRequestDeadline(ITEM_RESERVE_MS)) {
      // Still PENDING, so the next run picks them up.
      left = scheduledActions.length - index;
      logger.warn("Stopping scheduled actions before the deadline", { left });
      break;
    }

    const actionLogger = logger.with({
      scheduledActionId: scheduledAction.id,
      emailAccountId: scheduledAction.emailAccountId,
    });

    try {
      if (!scheduledAction.emailAccount?.account?.provider) {
        actionLogger.error("Email account or provider missing", {
          scheduledActionId: scheduledAction.id,
        });
        await prisma.scheduledAction.update({
          where: { id: scheduledAction.id },
          data: { status: ScheduledActionStatus.FAILED },
        });
        await checkAndCompleteExecutedRule(
          scheduledAction.executedRuleId,
          actionLogger,
        );
        failed += 1;
        continue;
      }

      const markedAction = await markQStashActionAsExecuting(
        scheduledAction.id,
      );
      if (!markedAction) {
        skipped += 1;
        continue;
      }

      const provider = await createEmailProvider({
        emailAccountId: scheduledAction.emailAccountId,
        provider: scheduledAction.emailAccount.account.provider,
        logger: actionLogger,
      });

      // The claimed row, which fences the run's writes on this claim.
      const executionResult = await executeScheduledAction(
        markedAction,
        provider,
        actionLogger,
      );

      if (executionResult.success) {
        processed += 1;
      } else {
        failed += 1;
      }
    } catch (error) {
      actionLogger.error("Scheduled action execution failed", { error });
      await prisma.scheduledAction.update({
        where: { id: scheduledAction.id },
        data: { status: ScheduledActionStatus.FAILED },
      });
      await checkAndCompleteExecutedRule(
        scheduledAction.executedRuleId,
        actionLogger,
      );
      failed += 1;
    }
  }

  return {
    processed,
    failed,
    skipped,
    left,
    total: scheduledActions.length,
  };
}

// The most frequent tick in the app, so new-mailbox health piggybacks on it.
function runScheduledWork(logger: Logger) {
  return runCronJob({
    logger,
    run: async () => {
      const [mail, firstHourHealth] = await Promise.all([
        processScheduledMail(logger),
        recordFirstHourHealthForNewMailboxes(logger).catch((error) => {
          logger.error("First-hour health check failed", { error });
          return { error: true };
        }),
      ]);
      return { ...mail, firstHourHealth };
    },
  });
}

async function processScheduledMail(logger: Logger) {
  // QStash delivers each action once, so a run it started that was killed is
  // only ever finished from here.
  const recoverInterrupted = recoverStaleScheduledActions(logger);

  if (!env.QSTASH_TOKEN) {
    const [
      scheduledActions,
      interruptedScheduledActions,
      snoozedThreads,
      scheduledEmails,
    ] = await Promise.all([
      processScheduledActions(logger),
      recoverInterrupted,
      processDueSnoozedThreads(logger),
      processDueScheduledEmails(logger),
    ]);
    return {
      scheduledActions,
      interruptedScheduledActions,
      snoozedThreads,
      scheduledEmails,
    };
  }

  const [interruptedScheduledActions, snoozedThreads, scheduledEmails] =
    await Promise.all([
      recoverInterrupted,
      processDueSnoozedThreads(logger),
      processDueScheduledEmails(logger),
    ]);
  return {
    scheduledEmails,
    scheduledActions: { skipped: true, reason: "qstash-configured" },
    interruptedScheduledActions,
    snoozedThreads,
  };
}
