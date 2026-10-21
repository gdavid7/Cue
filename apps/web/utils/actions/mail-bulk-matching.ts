"use server";

import { randomUUID } from "node:crypto";
import {
  matchingBulkJobSchema,
  startMatchingBulkActionSchema,
} from "@/utils/actions/mail-bulk-matching.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { mailBulkJobListings } from "@/utils/mail-bulk/job-listing";
import { enqueueMailBulkJob } from "@/utils/mail-bulk/run-matching-job";
import {
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  type MailBulkJobAction,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";

const UNDO_ACTION: Partial<Record<MailBulkJobAction, MailBulkJobAction>> = {
  archive: "unarchive",
  mark_read: "mark_unread",
  mark_unread: "mark_read",
};

export const startMatchingBulkActionAction = actionClient
  .metadata({ name: "startMatchingBulkAction" })
  .inputSchema(startMatchingBulkActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { scope: requestedScope, action, labelId },
    }) => {
      let scope = requestedScope;
      if (action === "delete_forever") {
        // Deleting for good only ever lists the trash itself, whatever else
        // the request names, so no folder, label or search can widen it.
        scope = { type: "trash" };
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        if (!emailProvider.deleteMessagesForever)
          throw new SafeError(
            "This account's mail can't be deleted forever from Cue",
          );
      }

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
      return { jobId };
    },
  );

export const undoMatchingBulkActionAction = actionClient
  .metadata({ name: "undoMatchingBulkAction" })
  .inputSchema(matchingBulkJobSchema)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { jobId } }) => {
      const source = await mailBulkJobStore.get(jobId);
      if (!source || source.emailAccountId !== emailAccountId)
        throw new SafeError("That action can no longer be undone");
      const action = UNDO_ACTION[source.action];
      if (!action || source.sourceJobId)
        throw new SafeError("That action can't be undone");

      // Asks the source to stop. Its delivery marks it cancelled once the
      // chunk in flight is counted, and the undo job waits for that before
      // restoring everything the source got through.
      await mailBulkJobStore.transition(
        jobId,
        ACTIVE_MAIL_BULK_JOB_STATUSES,
        "stopping",
      );

      const undoJobId = randomUUID();
      await mailBulkJobStore.create(undoJobId, {
        emailAccountId,
        action,
        sourceJobId: jobId,
        status: "applying",
        total: source.total,
        conversations: source.conversations,
        applied: 0,
        failed: 0,
        capped: false,
        updatedAt: Date.now(),
      });
      await enqueueMailBulkJob({
        jobId: undoJobId,
        emailAccountId,
        deferrals: 0,
      });
      logger.info("Undoing bulk action on matching mail", {
        jobId,
        undoJobId,
      });
      return { jobId: undoJobId };
    },
  );

export const cancelMatchingBulkActionAction = actionClient
  .metadata({ name: "cancelMatchingBulkAction" })
  .inputSchema(matchingBulkJobSchema)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { jobId } }) => {
    const job = await mailBulkJobStore.get(jobId);
    if (!job || job.emailAccountId !== emailAccountId)
      throw new SafeError("That action has already finished");
    await mailBulkJobStore.transition(
      jobId,
      ACTIVE_MAIL_BULK_JOB_STATUSES,
      "stopping",
    );
  });
