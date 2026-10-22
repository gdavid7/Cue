"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { activationSignalBody } from "@/utils/actions/activation.validation";
import {
  recordFirstSyncReady,
  recordFirstThreadOpened,
  recordFirstTriageAction,
} from "@/utils/analytics/activation";

// The client only says that a step happened; the server's Redis claim makes
// it count once, and nothing but the mailbox id and the event name is used.
export const recordActivationSignalAction = actionClient
  .metadata({ name: "recordActivationSignal" })
  .inputSchema(activationSignalBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { event } }) => {
    if (event === "first_sync_ready")
      await recordFirstSyncReady(emailAccountId);
    else if (event === "first_thread_opened")
      await recordFirstThreadOpened(emailAccountId);
    else await recordFirstTriageAction(emailAccountId);
  });
