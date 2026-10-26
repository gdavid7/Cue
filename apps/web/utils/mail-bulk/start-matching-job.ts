import { randomUUID } from "node:crypto";
import type {
  MatchingBulkAction,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import { mailBulkJobListings } from "@/utils/mail-bulk/job-listing";
import { enqueueMailBulkJob } from "@/utils/mail-bulk/run-matching-job";
import type { Logger } from "@/utils/logger";
import {
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";

/**
 * Starts a bulk action over every conversation one account's view or search
 * holds, as the inbox's "select all matching" does. The view is kept in the
 * job's Postgres listing; Redis and the queue only see ids and counters.
 */
export async function startMatchingBulkJob({
  emailAccountId,
  scope,
  action,
  labelId,
  logger,
}: {
  emailAccountId: string;
  scope: MatchingScope;
  action: MatchingBulkAction;
  labelId?: string;
  logger: Logger;
}) {
  const jobId = randomUUID();
  await mailBulkJobStore.create(jobId, {
    emailAccountId,
    action,
    labelId: action === "label" ? labelId : undefined,
    status: "listing",
    total: 0,
    conversations: 0,
    applied: 0,
    failed: 0,
    capped: false,
    updatedAt: Date.now(),
  });
  await mailBulkJobListings.create({ jobId, emailAccountId, scope });
  try {
    await enqueueMailBulkJob({ jobId, emailAccountId, deferrals: 0 });
  } catch (error) {
    // Nothing will ever list this view, so it isn't kept.
    await mailBulkJobListings.remove(jobId, emailAccountId);
    await mailBulkJobStore.transition(
      jobId,
      ACTIVE_MAIL_BULK_JOB_STATUSES,
      "failed",
    );
    throw error;
  }
  logger.info("Started bulk action on matching mail", { action, jobId });
  return jobId;
}
