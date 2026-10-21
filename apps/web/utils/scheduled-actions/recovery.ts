import { subMilliseconds } from "date-fns";
import type { Prisma } from "@/generated/prisma/client";
import {
  ActionType,
  ExecutedActionStatus,
  ScheduledActionStatus,
} from "@/generated/prisma/enums";
import { persistExecutedActionOutcome } from "@/utils/ai/executed-action-outcome";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { hasTimeBeforeRequestDeadline } from "@/utils/request-deadline-reader";
import { isNotFoundError } from "@/utils/prisma-helpers";
import {
  checkAndCompleteExecutedRule,
  executeScheduledAction,
  getClaimWhere,
} from "@/utils/scheduled-actions/executor";

// Both routes that run actions are killed after 300 seconds, so an action
// claimed longer ago than this has no live run left.
const EXECUTION_LEASE_MS = 10 * 60 * 1000;
// Runs in all, counting the one that was first interrupted.
const MAX_EXECUTION_ATTEMPTS = 3;
// Repeating an archive or label long after it was due could undo how the user
// has filed the mail since.
const MAX_RETRY_AGE_MS = 60 * 60 * 1000;
const BATCH_SIZE = 50;
const ITEM_RESERVE_MS = 30_000;

// Doing these twice leaves the mailbox as doing them once.
const REPEATABLE_ACTION_TYPES = new Set<ActionType>([
  ActionType.ARCHIVE,
  ActionType.LABEL,
  ActionType.MARK_READ,
  ActionType.STAR,
  ActionType.MOVE_FOLDER,
  ActionType.DELETE,
]);

const SEND_OUTCOME_UNKNOWN = {
  code: "SEND_OUTCOME_UNKNOWN",
  message:
    "The run was stopped while carrying out this action, so whether it went out is unknown. It was not repeated, so nothing is sent twice.",
};
const EXECUTION_INTERRUPTED_REPEATEDLY = {
  code: "EXECUTION_INTERRUPTED",
  message: `The run was stopped before this action finished, ${MAX_EXECUTION_ATTEMPTS} times in a row, so it was not tried again.`,
};
const EXECUTION_INTERRUPTED_TOO_LONG_AGO = {
  code: "EXECUTION_INTERRUPTED",
  message:
    "The run was stopped before this action finished, and it was due too long ago to try again safely.",
};
const RECOVERY_FAILED = {
  code: "RECOVERY_FAILED",
  message:
    "The run was stopped before this action finished, and it could not be finished afterwards.",
};

/**
 * Finishes scheduled actions whose run was killed and left them EXECUTING.
 * Repeatable actions run again; anything else is settled from the executed
 * action its run linked before calling the provider, and fails rather than
 * repeats when that record holds no outcome.
 */
export async function recoverStaleScheduledActions(logger: Logger) {
  try {
    return await recoverBatch(logger);
  } catch (error) {
    logger.error("Recovering interrupted scheduled actions failed", { error });
    return {
      retried: 0,
      completed: 0,
      failed: 0,
      skipped: 0,
      left: 0,
      total: 0,
      error: true,
    };
  }
}

async function recoverBatch(logger: Logger) {
  const staleBefore = subMilliseconds(new Date(), EXECUTION_LEASE_MS);
  const staleWhere = {
    status: ScheduledActionStatus.EXECUTING,
    OR: [
      { executionStartedAt: { lte: staleBefore } },
      // Claimed by a build that recorded no lease.
      { executionStartedAt: null, updatedAt: { lte: staleBefore } },
    ],
  } satisfies Prisma.ScheduledActionWhereInput;

  const staleActions = await prisma.scheduledAction.findMany({
    where: staleWhere,
    orderBy: { scheduledFor: "asc" },
    take: BATCH_SIZE,
    include: {
      emailAccount: { include: { account: true } },
      executedAction: true,
    },
  });

  const counts = { retried: 0, completed: 0, failed: 0, skipped: 0, left: 0 };

  for (const [index, staleAction] of staleActions.entries()) {
    if (!hasTimeBeforeRequestDeadline(ITEM_RESERVE_MS)) {
      counts.left = staleActions.length - index;
      break;
    }

    const log = logger.with({
      scheduledActionId: staleAction.id,
      emailAccountId: staleAction.emailAccountId,
      actionType: staleAction.actionType,
    });

    // Overlapping cron runs can find the same row; only one renews its lease.
    const claimedAt = new Date();
    const claim = await prisma.scheduledAction.updateMany({
      where: { id: staleAction.id, ...staleWhere },
      data: {
        executionStartedAt: claimedAt,
        executionAttempts: { increment: 1 },
      },
    });
    if (!claim.count) {
      counts.skipped += 1;
      continue;
    }

    const claimed = {
      ...staleAction,
      executionStartedAt: claimedAt,
      executionAttempts: staleAction.executionAttempts + 1,
    };
    try {
      const outcome = await recoverAction(staleAction, claimed, log);
      counts[outcome] += 1;
    } catch (error) {
      log.error("Failed to recover interrupted scheduled action", { error });
      await failAction(claimed, RECOVERY_FAILED, log);
      counts.failed += 1;
    }
  }

  return { ...counts, total: staleActions.length, error: false };
}

// `staleAction` is the row as the interrupted run left it; `claimed` is this
// run's claim on it, which fences every write.
async function recoverAction(
  staleAction: StaleScheduledAction,
  claimed: StaleScheduledAction,
  log: Logger,
): Promise<"retried" | "completed" | "failed"> {
  const { executedAction } = staleAction;

  if (executedAction?.executionStatus) {
    log.info("Interrupted scheduled action had already finished", {
      executionStatus: executedAction.executionStatus,
    });
    if (executedAction.executionStatus === ExecutedActionStatus.FAILED) {
      await failAction(claimed, null, log);
      return "failed";
    }
    await prisma.scheduledAction.updateMany({
      where: getClaimWhere(claimed),
      data: {
        status: ScheduledActionStatus.COMPLETED,
        executedAt: executedAction.executedAt ?? new Date(),
      },
    });
    await checkAndCompleteExecutedRule(staleAction.executedRuleId, log);
    return "completed";
  }

  // A run links its executed action before calling the provider, so a missing
  // link means the provider was never reached, unless the row predates leases.
  const mayHaveReachedProvider =
    !!executedAction || !staleAction.executionStartedAt;
  if (
    mayHaveReachedProvider &&
    !REPEATABLE_ACTION_TYPES.has(staleAction.actionType)
  ) {
    log.warn("Interrupted scheduled action has an unknown outcome");
    await failAction(claimed, SEND_OUTCOME_UNKNOWN, log);
    return "failed";
  }

  if (staleAction.executionAttempts >= MAX_EXECUTION_ATTEMPTS) {
    log.warn("Interrupted scheduled action keeps getting stopped", {
      attempts: staleAction.executionAttempts,
    });
    await failAction(claimed, EXECUTION_INTERRUPTED_REPEATEDLY, log);
    return "failed";
  }

  if (staleAction.scheduledFor.getTime() < Date.now() - MAX_RETRY_AGE_MS) {
    log.warn("Interrupted scheduled action is too old to repeat");
    await failAction(claimed, EXECUTION_INTERRUPTED_TOO_LONG_AGO, log);
    return "failed";
  }

  const accountProvider = staleAction.emailAccount?.account?.provider;
  if (!accountProvider) {
    log.error("Email account or provider missing");
    await failAction(claimed, null, log);
    return "failed";
  }

  log.info("Retrying interrupted scheduled action");
  const client = await createEmailProvider({
    emailAccountId: staleAction.emailAccountId,
    provider: accountProvider,
    logger: log,
  });
  const result = await executeScheduledAction(claimed, client, log);
  return result.success ? "retried" : "failed";
}

async function failAction(
  claimed: StaleScheduledAction,
  reason: { code: string; message: string } | null,
  log: Logger,
) {
  const error = reason && {
    ...reason,
    stack: null,
    statusCode: null,
    requestId: null,
  };

  if (error && !claimed.executedAction) {
    // Gives the rule's history an action that says why it failed.
    try {
      await prisma.scheduledAction.update({
        where: { ...getClaimWhere(claimed), executedAction: { is: null } },
        data: {
          status: ScheduledActionStatus.FAILED,
          executedAction: {
            create: {
              type: claimed.actionType,
              executedRuleId: claimed.executedRuleId,
              executionStatus: ExecutedActionStatus.FAILED,
              executionError: error,
              executedAt: new Date(),
            },
          },
        },
      });
    } catch (updateError) {
      if (!isNotFoundError(updateError)) throw updateError;
      log.warn("Another run took over this scheduled action, not failing it");
      return;
    }
  } else {
    const { count } = await prisma.scheduledAction.updateMany({
      where: getClaimWhere(claimed),
      data: { status: ScheduledActionStatus.FAILED },
    });
    if (!count) {
      log.warn("Another run took over this scheduled action, not failing it");
      return;
    }
    if (error && claimed.executedAction) {
      await persistExecutedActionOutcome({
        actionId: claimed.executedAction.id,
        status: ExecutedActionStatus.FAILED,
        error,
        logger: log,
      });
    }
  }

  await checkAndCompleteExecutedRule(claimed.executedRuleId, log);
}

type StaleScheduledAction = Prisma.ScheduledActionGetPayload<{
  include: {
    emailAccount: { include: { account: true } };
    executedAction: true;
  };
}>;
