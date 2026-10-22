"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { activationSignalBody } from "@/utils/actions/activation.validation";
import { ACTIVATION_SIGNAL_RECORDERS } from "@/utils/analytics/activation";

// The client only says that a step happened; the server's Redis claim makes
// it count once. Nothing but the mailbox id, the event name and the counts
// and timings its schema allows is used.
export const recordActivationSignalAction = actionClient
  .metadata({ name: "recordActivationSignal" })
  .inputSchema(activationSignalBody)
  .action(({ ctx: { emailAccountId }, parsedInput }) =>
    ACTIVATION_SIGNAL_RECORDERS[parsedInput.event](emailAccountId, parsedInput),
  );
