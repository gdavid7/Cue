"use server";

import { randomUUID } from "node:crypto";
import {
  matchingBulkJobSchema,
  startMatchingBulkActionSchema,
} from "@/utils/actions/mail-bulk-matching.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { enqueueMailBulkJob } from "@/utils/mail-bulk/run-matching-job";
import {
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
      parsedInput: { scope, action, labelId },
    }) => {
      if (action === "delete_forever") {
        // Deleting for good is only offered from the trash.
        if (scope.type !== "trash" || scope.q)
          throw new SafeError("Only mail in the trash can be deleted forever");
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
      });
      await enqueueMailBulkJob({ jobId, emailAccountId, scope, deferrals: 0 });
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

      // Stops the source where it is; the undo restores what it got through.
      if (source.status === "listing" || source.status === "applying")
        await mailBulkJobStore.update(jobId, { status: "cancelled" });

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
    if (job.status === "listing" || job.status === "applying")
      await mailBulkJobStore.update(jobId, { status: "cancelled" });
  });
