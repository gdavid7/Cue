"use server";

import { ActionType } from "@/generated/prisma/enums";
import { removeCueLabelsBody } from "@/utils/actions/cue-labels.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";
import {
  CUE_LABEL_SYSTEM_TYPES,
  findCueDefaultLabels,
} from "@/utils/label/cue-default-labels";
import prisma from "@/utils/prisma";
import { removeLabelFromMailSplits } from "@/utils/split-inbox/splits.server";

type RemoveCueLabelResult = {
  labelId: string;
  name: string | null;
  status: "removed" | "failed" | "not_found";
};

export const removeCueLabelsAction = actionClient
  .metadata({ name: "removeCueLabels" })
  .inputSchema(removeCueLabelsBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { labelIds },
    }) => {
      if (!isGoogleProvider(provider)) {
        throw new SafeError("Only Gmail labels can be removed here.");
      }

      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      // Checked against the mailbox, so this can only ever remove a label
      // named like one of Cue's, whatever ids the client sends.
      const cueLabels = findCueDefaultLabels(
        await emailProvider.getLabels({ includeHidden: true }),
      );

      const results: RemoveCueLabelResult[] = [];
      // One at a time: there are at most six, and Gmail rate-limits bursts.
      for (const labelId of labelIds) {
        const label = cueLabels.find((cueLabel) => cueLabel.id === labelId);
        if (!label) {
          results.push({ labelId, name: null, status: "not_found" });
          continue;
        }

        try {
          await emailProvider.deleteLabel(label.id);
        } catch (error) {
          logger.warn("Failed to remove Cue label", { error, labelId });
          results.push({ labelId, name: label.name, status: "failed" });
          continue;
        }

        await removeLabelFromMailSplits({ emailAccountId, labelId });
        // A Cue rule still applying the label would only create it again.
        await prisma.action.deleteMany({
          where: {
            emailAccountId,
            type: ActionType.LABEL,
            rule: { systemType: { in: CUE_LABEL_SYSTEM_TYPES } },
            OR: [{ labelId }, { labelId: null, label: label.name }],
          },
        });
        results.push({ labelId, name: label.name, status: "removed" });
      }

      return { results };
    },
  );
