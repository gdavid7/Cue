"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
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
} from "./assistant-chat-confirmation";
import { submitLocalMailSearchResultBody } from "./assistant-local-search.validation";
import { acceptLocalMailSearchResult } from "@/utils/ai/assistant/local-mail-search";

export const confirmAssistantEmailAction = actionClient
  .metadata({ name: "confirmAssistantEmail" })
  .inputSchema(confirmAssistantEmailActionBody)
  .action(
    async ({
      ctx: { emailAccountId, provider, logger },
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
