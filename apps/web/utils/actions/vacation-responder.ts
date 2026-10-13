"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { vacationResponderBody } from "@/utils/actions/vacation-responder.validation";
import { createEmailProvider } from "@/utils/email/provider";

export const updateVacationResponderAction = actionClient
  .metadata({ name: "updateVacationResponder" })
  .inputSchema(vacationResponderBody)
  .action(
    async ({ ctx: { emailAccountId, provider, logger }, parsedInput }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      await emailProvider.updateVacationResponder(parsedInput);
    },
  );
