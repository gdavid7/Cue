"use server";

import { actionClient } from "@/utils/actions/safe-action";
import { saveAttachmentToDriveBody } from "@/utils/actions/save-attachment.validation";
import { saveAttachmentToDrive } from "@/utils/attachments/save-to-drive";

export const saveAttachmentToDriveAction = actionClient
  .metadata({ name: "saveAttachmentToDrive" })
  .inputSchema(saveAttachmentToDriveBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { messageId, attachmentId, app },
    }) =>
      saveAttachmentToDrive({
        emailAccountId,
        provider,
        messageId,
        attachment: { attachmentId },
        app,
        logger,
      }),
  );
