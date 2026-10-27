import { NextResponse, after } from "next/server";
import {
  consumeStream,
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  type UIMessage,
} from "ai";
import { withEmailAccount } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { FIRST_TIME_EVENTS, trackFirstTimeEvent } from "@/utils/posthog";
import { getEmailAccountWithAi } from "@/utils/user/get";
import {
  aiProcessAssistantChat,
  ASSISTANT_CHAT_PIPELINE_VERSION,
} from "@/utils/ai/assistant/chat";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { convertToUIMessages } from "@/components/assistant-chat/helpers";
import { captureException } from "@/utils/error";
import {
  shouldCompact,
  compactMessages,
  buildCompactionSummaryMessage,
  extractMemories,
} from "@/utils/ai/assistant/compact";
import { projectEarlierTurnToolResults } from "@/utils/ai/assistant/trim-stale-tool-results";
import { getInboxStatsForChatContext } from "@/utils/ai/assistant/get-inbox-stats-for-chat-context";
import { formatUtcDate } from "@/utils/date";
import {
  buildUserChatMessageMetadata,
  mapUiMessagesToChatMessageRows,
  type AssistantChatRunMetadata,
} from "@/app/api/chat/chat-message-persistence";
import {
  ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE,
  type AssistantInput,
  assistantInputSchema,
} from "@/utils/actions/assistant-chat.validation";
import { buildInlineEmailActionSystemMessage } from "@/utils/ai/assistant/inline-email-actions";
import {
  mergeSeenRulesRevision,
  saveLastSeenRulesRevision,
} from "@/utils/ai/assistant/chat-seen-rules-revision";
import {
  getFailedToolNames,
  getToolFailureWarning,
} from "@/utils/ai/assistant/chat-response-guard";
import { flushLoggerSafely } from "@/utils/logger-flush";
import { createLocalMailSearch } from "@/utils/ai/assistant/local-mail-search";
import { withoutConfirmTokens } from "@/utils/ai/assistant/matching-query-actions";
import { resolveEmailAccountForId } from "@/utils/ai/assistant/chat-other-accounts";
import {
  parseOtherAccountEmailId,
  toOtherAccountEmailId,
} from "@/utils/ai/assistant/other-account-email-id";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import {
  claimActiveStream,
  clearActiveStream,
  getChatStreamContext,
  startChatRun,
} from "@/utils/chat/active-run";

export const maxDuration = 300;

export const POST = withEmailAccount("chat", async (request) => {
  const requestStartedAt = Date.now();
  const { userId } = request.auth;
  await assertWithinUserRateLimit({
    scope: "assistant-chat",
    userId: request.auth.userId,
    limit: 60,
    windowSeconds: 5 * 60,
    logger: request.logger,
  });

  const json = await request.json();
  const { data, error } = assistantInputSchema.safeParse(json);

  if (error) {
    const requestMetadata = getInvalidChatRequestMetadata(json);
    const messageTooLong = error.issues.some(
      (issue) =>
        issue.code === "too_big" &&
        issue.path.length === 4 &&
        issue.path[0] === "message" &&
        issue.path[1] === "parts" &&
        typeof issue.path[2] === "number" &&
        issue.path[3] === "text",
    );

    request.logger.warn("Assistant chat request rejected", {
      ...requestMetadata,
      failureCategory: messageTooLong ? "message_too_long" : "validation_error",
      statusCode: 400,
      validationIssueCodes: [
        ...new Set(error.issues.map((issue) => issue.code)),
      ],
    });
    await flushLoggerSafely(request.logger, {
      action: "assistant-chat",
      flushReason: "chat-validation-error",
    });

    return NextResponse.json(
      {
        error: messageTooLong
          ? ASSISTANT_CHAT_MAX_TEXT_LENGTH_MESSAGE
          : "Invalid chat message.",
      },
      { status: 400 },
    );
  }

  const [pageAccountUser, existingChat] = await Promise.all([
    getEmailAccountWithAi({ emailAccountId: request.auth.emailAccountId }),
    getChatWithCompactions(data.id),
  ]);

  // A chat covers all of the user's accounts, so it is theirs from any page.
  // Another user's chat is refused before anything about it is used.
  if (existingChat && existingChat.emailAccount.userId !== userId) {
    return NextResponse.json(
      { error: "You are not authorized to access this chat" },
      { status: 403 },
    );
  }

  // The chat runs in the account it was started in, its anchor, wherever it
  // is opened: rules, settings and new mail act there.
  const emailAccountId =
    existingChat?.emailAccountId ?? request.auth.emailAccountId;
  const user =
    emailAccountId === request.auth.emailAccountId
      ? pageAccountUser
      : await getEmailAccountWithAi({ emailAccountId });

  if (!user) {
    return NextResponse.json(
      { error: "Email account not found" },
      { status: 404 },
    );
  }

  const chat =
    existingChat ||
    (await createNewChat({
      emailAccountId,
      chatId: data.id,
      logger: request.logger,
    }));

  if (!chat) {
    return NextResponse.json(
      { error: "Failed to get or create chat" },
      { status: 500 },
    );
  }

  if (chat.deletedAt) {
    return NextResponse.json(
      { error: "This chat has been deleted." },
      { status: 410 },
    );
  }

  const chatHasHistory =
    chat.messages.length > 0 || chat.compactions.length > 0;
  // The inbox snapshot only goes into a conversation's first turn, so later
  // turns skip the provider call (and its wait of up to 2 s).
  const isFirstUserTurn =
    chat.compactions.length === 0 &&
    !chat.messages.some((chatMessage) => chatMessage.role === "user");
  const inboxStatsPromise = isFirstUserTurn
    ? getInboxStatsForChatContext({
        userId,
        emailAccountId,
        provider: user.account.provider,
        logger: request.logger,
      })
    : Promise.resolve(null);
  const { message, context, inlineActions } = data;
  const chatRunId = crypto.randomUUID();
  const runStartedAt = Date.now();
  const runLogger = request.logger.with({ chatId: chat.id, chatRunId });

  // The reply's message id doubles as its stream id, so a client can name the
  // run it wants to stop by the message it is already showing.
  const streamId = crypto.randomUUID();
  const chatRun = await startChatRun(streamId);
  if (!(await claimActiveStream({ chatId: chat.id, streamId }))) {
    chatRun.end();
    return NextResponse.json(
      { error: "A reply is already in progress." },
      { status: 409 },
    );
  }

  // Whatever the turn holds (such as Gmail's demand signal) is let go when
  // the reply ends, and also when setting it up or streaming it fails.
  const turnCleanups: Array<() => void> = [];
  const runTurnCleanups = () => {
    for (const cleanup of turnCleanups.splice(0)) cleanup();
  };

  try {
    const hiddenInlineActionMessage =
      buildHiddenInlineActionMessage(inlineActions);

    const savedUserMessage = await saveChatMessage({
      chat: { connect: { id: chat.id } },
      id: message.id,
      role: "user",
      parts: message.parts,
      metadata: buildUserChatMessageMetadata({
        runId: chatRunId,
        context,
        inlineActions,
      }),
    });

    after(() =>
      trackFirstTimeEvent({
        emailAccountId,
        event: FIRST_TIME_EVENTS.FIRST_CHAT_MESSAGE,
      }),
    );

    const latestCompaction = chat.compactions[0];

    const messagesForModel = latestCompaction
      ? chat.messages.filter(
          (m) => m.createdAt >= latestCompaction.compactedBeforeCreatedAt,
        )
      : chat.messages;

    const conversationUiMessages = [
      ...convertToUIMessages({ ...chat, messages: messagesForModel }),
      message,
    ];

    const uiMessages = [
      ...conversationUiMessages,
      ...(hiddenInlineActionMessage ? [hiddenInlineActionMessage] : []),
    ];

    // A preview card's confirm token is for its button alone: neither the
    // model nor memory extraction reads it.
    const conversationModelMessages = withoutConfirmTokens(
      await convertToModelMessages(conversationUiMessages),
    );

    let modelMessages = hiddenInlineActionMessage
      ? withoutConfirmTokens(await convertToModelMessages(uiMessages))
      : conversationModelMessages;

    if (latestCompaction) {
      modelMessages = [
        buildCompactionSummaryMessage(latestCompaction.summary),
        ...modelMessages,
      ];
    }

    if (shouldCompact(projectEarlierTurnToolResults(modelMessages))) {
      try {
        const {
          compactedMessages,
          summary,
          compactedCount,
          keptUserMessageCount,
        } = await compactMessages({
          messages: modelMessages,
          user,
          logger: request.logger,
        });

        if (compactedCount > 0 && summary.trim().length > 0) {
          modelMessages = compactedMessages;

          const compactedBeforeCreatedAt = getCompactionBoundary({
            storedMessages: messagesForModel,
            keptUserMessageCount,
            newUserMessageCreatedAt: savedUserMessage?.createdAt,
          });

          const [, memories] = await Promise.all([
            prisma.$transaction([
              prisma.chatCompaction.create({
                data: {
                  chatId: chat.id,
                  summary,
                  messageCount: compactedCount,
                  compactedBeforeCreatedAt,
                },
              }),
              prisma.chat.update({
                where: { id: chat.id },
                data: { compactionCount: { increment: 1 } },
              }),
            ]),
            extractMemories({
              messages: conversationModelMessages,
              user,
            }).catch((err) => {
              request.logger.error("Failed to extract memories", {
                error: err,
              });
              return [];
            }),
          ]);

          if (memories.length > 0) {
            await prisma.chatMemory.createMany({
              data: memories.map((m) => ({
                content: m.content,
                chatId: chat.id,
                emailAccountId,
              })),
              skipDuplicates: true,
            });
          }
        }
      } catch (compactionError) {
        request.logger.error(
          "Chat compaction failed, continuing with full history",
          {
            error: compactionError,
          },
        );
      }
    }

    const [memories, inboxStats] = await Promise.all([
      prisma.chatMemory
        .findMany({
          // Memories follow the user, whichever account the chat was in.
          where: { emailAccount: { userId } },
          orderBy: { createdAt: "desc" },
          take: 20,
          select: { content: true, createdAt: true },
        })
        .then(
          (recentMemories) =>
            recentMemories.map((m) => ({
              content: m.content,
              date: formatUtcDate(m.createdAt),
            })),
          (error) => {
            request.logger.warn("Failed to load memories for chat", { error });
            return [];
          },
        ),
      inboxStatsPromise,
    ]);
    let seenRulesRevision: number | null = null;
    const assistantRun: AssistantChatRunMetadata = {
      runId: chatRunId,
      provider: null,
      modelName: null,
      pipelineVersion: ASSISTANT_CHAT_PIPELINE_VERSION,
      deploymentCommit: process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null,
      finishReason: null,
      stepCount: 0,
      toolCallCount: 0,
      visibleTextProduced: false,
    };
    // Searches are answered locally only by a browser that says it can, and
    // for Outlook only by one that reads Outlook's syntax: older tabs read
    // every query as Gmail's.
    const localMailSearch =
      data.localMailSearch &&
      (isGoogleProvider(user.account.provider) ||
        (isMicrosoftProvider(user.account.provider) &&
          data.localMailSearchSyntaxes.includes("outlook")))
        ? createLocalMailSearch({
            emailAccountId,
            canCount: data.localMailCount,
            logger: runLogger,
            abortSignal: chatRun.abortSignal,
          })
        : undefined;
    const result = await aiProcessAssistantChat({
      localMailSearch,
      registerCleanup: (cleanup) => turnCleanups.push(cleanup),
      messages: modelMessages,
      conversationMessagesForMemory: conversationModelMessages,
      emailAccountId,
      user,
      context,
      chatId: chat.id,
      supportsInlineEmailCards: data.supportsInlineEmailCards,
      openThread: await resolveOpenThread({
        threadId: data.openThreadId,
        messageId: data.openMessageId,
        userId,
        emailAccountId,
        provider: user.account.provider,
      }),
      chatLastSeenRulesRevision: chat.lastSeenRulesRevision,
      chatHasHistory,
      memories,
      inboxStats,
      isFirstUserTurn,
      onRulesStateExposed: (rulesRevision) => {
        seenRulesRevision = mergeSeenRulesRevision(
          seenRulesRevision,
          rulesRevision,
        );
      },
      onModelResolved: (resolvedModel) => {
        assistantRun.provider = resolvedModel.provider;
        assistantRun.modelName = resolvedModel.modelName ?? null;
      },
      onStepEnd: (step) => {
        assistantRun.stepCount += 1;
        assistantRun.toolCallCount += step.toolCalls.length;
      },
      onEnd: (result) => {
        assistantRun.finishReason = result.finishReason;
      },
      abortSignal: chatRun.abortSignal,
      logger: runLogger,
    });
    const modelStartedAfterMs = Date.now() - requestStartedAt;
    let timeToFirstTokenMs: number | null = null;

    const stream = createUIMessageStream({
      generateId: () => streamId,
      execute: async ({ writer }) => {
        localMailSearch?.attach(writer);
        let responseMessage: UIMessage | null = null;

        for await (const chunk of result.toUIMessageStream({
          sendFinish: false,
          onEnd: ({ responseMessage: finishedResponseMessage }) => {
            responseMessage = finishedResponseMessage;
          },
        })) {
          if (timeToFirstTokenMs === null && chunk.type === "text-delta") {
            timeToFirstTokenMs = Date.now() - requestStartedAt;
          }
          writer.write(chunk);
        }

        if (chatRun.abortSignal.aborted) return;

        const warning = getToolFailureWarning(responseMessage);
        if (!warning) return;

        runLogger.warn("Assistant chat completed with tool failures", {
          failedTools: getFailedToolNames(responseMessage),
        });

        const warningPartId = crypto.randomUUID();
        writer.write({ type: "text-start", id: warningPartId });
        writer.write({
          type: "text-delta",
          id: warningPartId,
          delta: `\n\n${warning}`,
        });
        writer.write({ type: "text-end", id: warningPartId });
      },
      onEnd: async ({ messages: endMessages, isAborted }) => {
        try {
          // A stopped reply is saved as it stood, minus tool calls that never
          // got a result, which would otherwise show as running forever.
          const messages = isAborted
            ? endMessages.map(removeIncompleteToolParts)
            : endMessages;
          assistantRun.visibleTextProduced = hasVisibleAssistantText(messages);
          const persistableMessages = messages.filter(
            isPersistableAssistantMessage,
          );

          if (persistableMessages.length < messages.length) {
            runLogger.error("Skipping empty assistant chat messages", {
              skippedCount: messages.length - persistableMessages.length,
            });
          }

          let insertedMessageCount = 0;
          if (persistableMessages.length > 0) {
            const result = await saveChatMessages(
              persistableMessages,
              chat.id,
              runLogger,
              assistantRun,
            );
            insertedMessageCount = result.count;
          }

          if (seenRulesRevision != null) {
            await saveLastSeenRulesRevision({
              chatId: chat.id,
              rulesRevision: seenRulesRevision,
              logger: runLogger,
            });
          }

          runLogger.info("Assistant chat run completed", {
            provider: assistantRun.provider,
            modelName: assistantRun.modelName,
            pipelineVersion: assistantRun.pipelineVersion,
            deploymentCommit: assistantRun.deploymentCommit,
            finishReason: assistantRun.finishReason,
            stepCount: assistantRun.stepCount,
            toolCallCount: assistantRun.toolCallCount,
            visibleTextProduced: assistantRun.visibleTextProduced,
            stopped: isAborted,
            durationMs: Date.now() - runStartedAt,
            modelStartedAfterMs,
            timeToFirstTokenMs,
            assistantMessageCount: messages.filter(
              (message) => message.role === "assistant",
            ).length,
            insertedMessageCount,
          });
        } finally {
          runTurnCleanups();
          chatRun.end();
          await clearActiveStream({ chatId: chat.id, streamId });
        }

        await flushLoggerSafely(runLogger, {
          action: "assistant-chat",
          flushReason: "chat-stream-finish",
        });
      },
    });

    const streamContext = getChatStreamContext();
    return createUIMessageStreamResponse({
      stream,
      // The run keeps going if the client disconnects, so its reply is still
      // saved; with Redis the stream is also kept for the client to resume.
      consumeSseStream: ({ stream: sseStream }) => {
        if (!streamContext) {
          consumeStream({ stream: sseStream });
          return;
        }
        streamContext
          .createNewResumableStream(streamId, () => sseStream)
          .catch((error) => {
            runLogger.error("Failed to create resumable chat stream", {
              error,
            });
            consumeStream({ stream: sseStream });
          });
      },
    });
  } catch (error) {
    runTurnCleanups();
    chatRun.end();
    await clearActiveStream({ chatId: chat.id, streamId });
    runLogger.error("Error in assistant chat", { error });
    await flushLoggerSafely(runLogger, {
      action: "assistant-chat",
      flushReason: "chat-error",
    });
    return NextResponse.json(
      { error: "Error in assistant chat" },
      { status: 500 },
    );
  }
});

async function createNewChat({
  emailAccountId,
  chatId,
  logger,
}: {
  emailAccountId: string;
  chatId: string;
  logger: Logger;
}) {
  try {
    const newChat = await prisma.chat.create({
      data: { emailAccountId, id: chatId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        compactions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    logger.info("New chat created", { chatId: newChat.id, emailAccountId });
    return newChat;
  } catch (error) {
    logger.error("Failed to create new chat", { error, emailAccountId });
    return;
  }
}

async function getChatWithCompactions(chatId: string) {
  return prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      compactions: { orderBy: { createdAt: "desc" }, take: 1 },
      emailAccount: { select: { userId: true } },
    },
  });
}

async function saveChatMessage(message: Prisma.ChatMessageCreateInput) {
  return prisma.chatMessage.create({ data: message });
}

async function saveChatMessages(
  messages: UIMessage[],
  chatId: string,
  logger: Logger,
  assistantRun: AssistantChatRunMetadata,
) {
  try {
    const rows = mapUiMessagesToChatMessageRows(messages, chatId, {
      assistantRun,
    });
    const assistantMessages = messages.filter(
      (message) => message.role === "assistant",
    );

    logger.info("Persisting chat messages", {
      chatId,
      messageCount: messages.length,
      assistantMessageIds: assistantMessages.map((message) => message.id),
      assistantToolCallIds: assistantMessages.flatMap((message) =>
        getToolCallIdsFromUiParts(message.parts),
      ),
    });

    const result = await prisma.chatMessage.createMany({
      data: rows,
      skipDuplicates: true,
    });

    logger.info("Persisted chat messages", {
      chatId,
      insertedCount: result.count,
    });

    return result;
  } catch (error) {
    logger.error("Failed to save chat messages", { error, chatId });
    captureException(error, { extra: { chatId } });
    throw error;
  }
}

function buildHiddenInlineActionMessage(
  inlineActions?: AssistantInput["inlineActions"],
) {
  const text = buildInlineEmailActionSystemMessage(inlineActions);
  if (!text) return null;

  return {
    id: crypto.randomUUID(),
    role: "system" as const,
    parts: [{ type: "text" as const, text }],
  } satisfies UIMessage;
}

function isPersistableAssistantMessage(message: UIMessage) {
  if (message.role !== "assistant") return true;

  return hasRenderableAssistantResponse(message);
}

function hasRenderableAssistantResponse(
  message: Pick<UIMessage, "parts"> | null | undefined,
) {
  const parts = message?.parts;
  if (!parts?.length) return false;

  return parts.some((part) => {
    if (part.type !== "text") return true;
    return part.text.trim().length > 0;
  });
}

function hasVisibleAssistantText(messages: UIMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts.some(
        (part) => part.type === "text" && part.text.trim().length > 0,
      ),
  );
}

function getToolCallIdsFromUiParts(parts: UIMessage["parts"] | undefined) {
  return (
    parts?.flatMap((part) => ("toolCallId" in part ? [part.toolCallId] : [])) ||
    []
  );
}

function getInvalidChatRequestMetadata(value: unknown) {
  if (!value || typeof value !== "object") {
    return { attachmentCount: 0, textLength: 0 };
  }

  const message = (value as Record<string, unknown>).message;
  if (!message || typeof message !== "object") {
    return { attachmentCount: 0, textLength: 0 };
  }

  const parts = (message as Record<string, unknown>).parts;
  if (!Array.isArray(parts)) {
    return { attachmentCount: 0, textLength: 0 };
  }

  return parts.reduce(
    (metadata, part) => {
      if (!part || typeof part !== "object") return metadata;

      const candidate = part as Record<string, unknown>;
      if (candidate.type === "text" && typeof candidate.text === "string") {
        metadata.textLength += candidate.text.length;
      } else if (candidate.type === "file") {
        metadata.attachmentCount += 1;
      }

      return metadata;
    },
    { attachmentCount: 0, textLength: 0 },
  );
}

function removeIncompleteToolParts(message: UIMessage): UIMessage {
  return {
    ...message,
    parts: message.parts.filter(
      (part) =>
        !(
          "toolCallId" in part &&
          (part.state === "input-streaming" || part.state === "input-available")
        ),
    ),
  };
}

// The summary covers the model's history up to the turn its kept part starts
// at, so the next request loads stored messages from that turn's user
// message on. The kept part also holds the new user message, which is not
// among the stored messages.
function getCompactionBoundary({
  storedMessages,
  keptUserMessageCount,
  newUserMessageCreatedAt,
}: {
  storedMessages: Array<{ role: string; createdAt: Date }>;
  keptUserMessageCount: number;
  newUserMessageCreatedAt?: Date;
}) {
  const keptStoredUserMessages = keptUserMessageCount - 1;
  const storedUserMessages = storedMessages.filter(
    (message) => message.role === "user",
  );
  const firstKept =
    keptStoredUserMessages > 0
      ? storedUserMessages.at(-keptStoredUserMessages)
      : undefined;

  return firstKept?.createdAt ?? newUserMessageCreatedAt ?? new Date();
}

// A thread open in another account reaches the model named with that
// account, once the account is checked to be the user's, so the tools that
// read it go to the right mailbox. One in an account that is not theirs is
// dropped, as is a message id from another account than its thread's.
async function resolveOpenThread({
  threadId,
  messageId,
  userId,
  emailAccountId,
  provider,
}: {
  threadId?: string;
  messageId?: string;
  userId: string;
  emailAccountId: string;
  provider: string;
}) {
  if (!threadId) return;
  const thread = await resolveEmailAccountForId({
    id: threadId,
    userId,
    emailAccountId,
    provider,
  });
  if (!thread) return;

  const message = messageId ? parseOtherAccountEmailId(messageId) : null;
  const messageAccountId = message?.emailAccountId ?? emailAccountId;
  const messageProviderId = message?.id ?? messageId;
  const named = (id: string) =>
    thread.otherAccount ? toOtherAccountEmailId(thread.emailAccountId, id) : id;

  return {
    threadId: named(thread.id),
    messageId:
      messageProviderId && messageAccountId === thread.emailAccountId
        ? named(messageProviderId)
        : undefined,
  };
}
