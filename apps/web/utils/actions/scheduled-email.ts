"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  cancelHeldSendBody,
  scheduleEmailBody,
  scheduledEmailIdBody,
} from "@/utils/actions/scheduled-email.validation";
import { cancelHeldEngineSend } from "@/utils/mail-api/operations";
import {
  scheduleEmail,
  cancelScheduledEmail,
  cancelEmailReminder,
  retryScheduledEmail,
  processScheduledEmail,
} from "@/utils/scheduled-email/service";

export const scheduleEmailAction = actionClient
  .metadata({ name: "scheduleEmail" })
  .inputSchema(scheduleEmailBody)
  .action(async ({ ctx: { emailAccountId, logger }, parsedInput }) => {
    const row = await scheduleEmail(emailAccountId, parsedInput);
    if (!parsedInput.sendAt) await processScheduledEmail(row.id, logger);
    return { id: row.id };
  });

export const cancelScheduledEmailAction = actionClient
  .metadata({ name: "cancelScheduledEmail" })
  .inputSchema(scheduledEmailIdBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { id } }) => {
    await cancelScheduledEmail(emailAccountId, id);
  });

export const retryScheduledEmailAction = actionClient
  .metadata({ name: "retryScheduledEmail" })
  .inputSchema(scheduledEmailIdBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { id } }) => {
    await retryScheduledEmail(emailAccountId, id);
  });

export const cancelEmailReminderAction = actionClient
  .metadata({ name: "cancelEmailReminder" })
  .inputSchema(scheduledEmailIdBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { id } }) => {
    await cancelEmailReminder(emailAccountId, id);
  });

// Undo for a send the server holds, reached without the mail engine: an
// account switch closes the engine the send was queued on.
export const cancelHeldSendAction = actionClient
  .metadata({ name: "cancelHeldSend" })
  .inputSchema(cancelHeldSendBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { operationId } }) => {
    const status = await cancelHeldEngineSend(emailAccountId, operationId);
    return { status };
  });
