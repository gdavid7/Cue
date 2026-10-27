"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  cancelAssistantMatchingActionBody,
  confirmAssistantMatchingActionBody,
  confirmAssistantCreateRuleBody,
  confirmAssistantEmailActionBody,
  confirmAssistantSaveMemoryBody,
  confirmAssistantLearnedPatternsBody,
  confirmAssistantUpdateRuleBody,
} from "./assistant-chat.validation";
import {
  confirmAssistantCreateRuleForAccount,
  confirmAssistantEmailActionForAccount,
  confirmAssistantSaveMemoryForAccount,
  confirmAssistantLearnedPatternsForAccount,
  confirmAssistantUpdateRuleForAccount,
  persistAssistantMatchingActionOutcome,
} from "./assistant-chat-confirmation";
import {
  cancelMatchingQueryAction,
  confirmMatchingQueryAction,
} from "@/utils/ai/assistant/chat-matching-actions";
import { submitLocalMailSearchResultBody } from "./assistant-local-search.validation";
import { acceptLocalMailSearchResult } from "@/utils/ai/assistant/local-mail-search";

export const confirmAssistantEmailAction = actionClient
  .metadata({ name: "confirmAssistantEmail" })
  .inputSchema(confirmAssistantEmailActionBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, userId, logger },
      parsedInput: {
        chatId,
        chatMessageId,
        toolCallId,
        actionType,
        contentOverride,
      },
    }) =>
      confirmAssistantEmailActionForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        actionType,
        contentOverride,
        waitForPersistence: true,
        emailAccountId,
        provider,
        userId,
        logger,
      }),
  );

export const confirmAssistantCreateRule = actionClient
  .metadata({ name: "confirmAssistantCreateRule" })
  .inputSchema(confirmAssistantCreateRuleBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) =>
      confirmAssistantCreateRuleForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        provider,
        logger,
      }),
  );

export const confirmAssistantUpdateRule = actionClient
  .metadata({ name: "confirmAssistantUpdateRule" })
  .inputSchema(confirmAssistantUpdateRuleBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) =>
      confirmAssistantUpdateRuleForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        provider,
        logger,
      }),
  );

export const confirmAssistantLearnedPatterns = actionClient
  .metadata({ name: "confirmAssistantLearnedPatterns" })
  .inputSchema(confirmAssistantLearnedPatternsBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) =>
      confirmAssistantLearnedPatternsForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        logger,
      }),
  );

// The browser's answer to an inbox search the assistant asked it for.
export const submitLocalMailSearchResult = actionClient
  .metadata({ name: "submitLocalMailSearchResult" })
  .inputSchema(submitLocalMailSearchResultBody)
  .action(
    async ({
      ctx: { userId, emailAccountId, logger },
      parsedInput: { requestId, result },
    }) => ({
      accepted: await acceptLocalMailSearchResult({
        userId,
        emailAccountId,
        requestId,
        result,
        logger,
      }),
    }),
  );

export const confirmAssistantSaveMemory = actionClient
  .metadata({ name: "confirmAssistantSaveMemory" })
  .inputSchema(confirmAssistantSaveMemoryBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { chatId, chatMessageId, toolCallId },
    }) =>
      confirmAssistantSaveMemoryForAccount({
        chatId,
        chatMessageId,
        toolCallId,
        waitForPersistence: true,
        emailAccountId,
        logger,
      }),
  );

// The user's Confirm on a manageInbox preview over a whole search. The token
// is spent before anything starts, so one preview starts one job.
export const confirmAssistantMatchingAction = actionClient
  .metadata({ name: "confirmAssistantMatchingAction" })
  .inputSchema(confirmAssistantMatchingActionBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, userId, logger },
      parsedInput: { chatId, chatMessageId, toolCallId, confirmToken, query },
    }) => {
      const started = await confirmMatchingQueryAction({
        emailAccountId,
        provider,
        userId,
        chatId,
        toolCallId,
        confirmToken,
        query,
        logger,
      });
      // The job has started either way; the card only loses its record.
      await persistAssistantMatchingActionOutcome({
        chatId,
        chatMessageId,
        toolCallId,
        emailAccountId,
        outcome: {
          status: "started",
          jobId: started.jobId,
          messageCap: started.messageCap,
          jobs: started.jobs,
          ...(started.notStarted ? { notStarted: started.notStarted } : {}),
        },
        logger,
      }).catch((error) => {
        logger.warn("Could not record a started matching action", { error });
      });
      return started;
    },
  );

export const cancelAssistantMatchingAction = actionClient
  .metadata({ name: "cancelAssistantMatchingAction" })
  .inputSchema(cancelAssistantMatchingActionBody)
  .action(
    async ({
      ctx: { emailAccountId, logger },
      parsedInput: { chatId, chatMessageId, toolCallId, confirmToken },
    }) => {
      // Throws when Confirm (or another Cancel) already took the token, so
      // the card is only marked cancelled when nothing started.
      await cancelMatchingQueryAction({
        emailAccountId,
        chatId,
        toolCallId,
        confirmToken,
        logger,
      });
      await persistAssistantMatchingActionOutcome({
        chatId,
        chatMessageId,
        toolCallId,
        emailAccountId,
        outcome: { status: "cancelled" },
        logger,
      }).catch((error) => {
        logger.warn("Could not record a cancelled matching action", { error });
      });
    },
  );
