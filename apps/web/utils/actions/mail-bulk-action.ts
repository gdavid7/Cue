"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  bulkArchiveThreadsActionSchema,
  bulkSenderActionSchema,
  deleteMessagesForeverSchema,
} from "@/utils/actions/mail-bulk-action.validation";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";

export const bulkArchiveThreadsAction = actionClient
  .metadata({ name: "bulkArchiveThreads", gmailPriority: "sync" })
  .inputSchema(bulkArchiveThreadsActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { threads },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      const result = await emailProvider.bulkArchiveThreads(
        threads,
        emailAccount.email,
      );

      const context = {
        failedThreadCount: result.failedThreadIds.length,
        succeededThreadCount: result.succeededThreadIds.length,
        threadCount: threads.length,
      };
      if (result.failedThreadIds.length) {
        logger.warn("Bulk thread archive completed with failures", context);
      } else {
        logger.info("Completed bulk thread archive", context);
      }

      return result;
    },
  );

export const bulkArchiveAction = actionClient
  .metadata({ name: "bulkArchive", gmailPriority: "sync" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkArchiveFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );

export const bulkTrashAction = actionClient
  .metadata({ name: "bulkTrash", gmailPriority: "sync" })
  .inputSchema(bulkSenderActionSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, emailAccount, logger },
      parsedInput: { froms },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });

      await emailProvider.bulkTrashFromSenders(
        froms,
        emailAccount.email,
        emailAccountId,
      );
    },
  );

export const deleteMessagesForeverAction = actionClient
  .metadata({ name: "deleteMessagesForever" })
  .inputSchema(deleteMessagesForeverSchema)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { messageIds },
    }) => {
      const emailProvider = await createEmailProvider({
        emailAccountId,
        provider,
        logger,
      });
      if (!emailProvider.deleteMessagesForever)
        throw new SafeError(
          "This account's mail can't be deleted forever from Cue",
        );

      // The provider deletes only what is in the trash as it goes, so a
      // conversation's other messages, such as a sent reply, stay put.
      const deletedIds = await emailProvider.deleteMessagesForever(messageIds);

      logger.info("Deleted messages forever", {
        requestedCount: messageIds.length,
        deletedCount: deletedIds.length,
      });
      return { deletedIds };
    },
  );
