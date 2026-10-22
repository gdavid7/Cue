"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { activationSignalBody } from "@/utils/actions/activation.validation";
import { ACTIVATION_SIGNAL_RECORDERS } from "@/utils/analytics/activation";

// The client only says that a step happened; the server's Redis claim makes
// it count once, and nothing but the mailbox id and the event name is used.
export const recordActivationSignalAction = actionClient
  .metadata({ name: "recordActivationSignal" })
  .inputSchema(activationSignalBody)
  .action(({ ctx: { emailAccountId }, parsedInput: { event } }) =>
    ACTIVATION_SIGNAL_RECORDERS[event](emailAccountId),
  );
