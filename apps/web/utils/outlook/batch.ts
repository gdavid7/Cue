import type { Message } from "@microsoft/microsoft-graph-types";
import type { Logger } from "@/utils/logger";
import type { OutlookClient } from "@/utils/outlook/client";
import type { BulkArchiveResult, BulkArchiveThread } from "@/utils/email/types";
import type { ParsedMessage } from "@/utils/types";
import { escapeODataString } from "@/utils/outlook/odata-escape";
import {
  convertMessage,
  getCategoryMap,
  getFolderIds,
  MESSAGE_EXPAND_ATTACHMENTS,
  MESSAGE_SELECT_FIELDS,
} from "@/utils/outlook/message";
import { MICROSOFT_MAILBOX_CONCURRENCY_LIMIT } from "@/utils/outlook/mailbox-concurrency";
import {
  extractErrorInfo,
  isRetryableError,
  withMicrosoftGraphRetry,
} from "@/utils/outlook/retry";
import { resolveMicrosoftGraphNextLink } from "@/utils/outlook/page-token";
import {
  publishBulkActionToTinybird,
  updateEmailMessagesForSender,
} from "@/utils/email/bulk-action-tracking";

const GRAPH_JSON_BATCH_LIMIT = 20; // Microsoft Graph JSON batching limit
const THREAD_PARTICIPANT_SELECT_FIELDS =
  "id,conversationId,from,toRecipients,receivedDateTime";

type GraphBatchRequestItem<TBody = unknown> = {
  id: string;
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: TBody;
};

type GraphBatchResponseItem<TBody = unknown> = {
  id: string;
  status: number;
  headers?: Record<string, string>;
  body?: TBody | null;
};

type GraphBatchResponse<TBody = unknown> = {
  responses?: GraphBatchResponseItem<TBody>[];
};

type MoveMessagesBatchResult = {
  movedMessageIds: string[];
  hasErrors: boolean;
};

async function batch<TRequestBody = unknown, TResponseBody = unknown>({
  client,
  requests,
  chunkSize,
  onFailure,
  shouldStop,
  context,
  logger,
}: {
  client: OutlookClient;
  requests: GraphBatchRequestItem<TRequestBody>[];
  chunkSize?: number;
  onFailure?: (params: {
    request?: GraphBatchRequestItem<TRequestBody>;
    response: GraphBatchResponseItem<TResponseBody>;
  }) => void;
  shouldStop?: (responses: GraphBatchResponseItem<TResponseBody>[]) => boolean;
  context?: Record<string, unknown>;
  logger: Logger;
}): Promise<GraphBatchResponseItem<TResponseBody>[]> {
  if (requests.length === 0) return [];

  const graphClient = client.getClient();
  const aggregatedResponses: GraphBatchResponseItem<TResponseBody>[] = [];
  const effectiveChunkSize = Math.min(
    chunkSize ?? GRAPH_JSON_BATCH_LIMIT,
    GRAPH_JSON_BATCH_LIMIT,
  );

  for (let start = 0; start < requests.length; start += effectiveChunkSize) {
    const chunk = requests.slice(start, start + effectiveChunkSize);

    try {
      const response = (await graphClient
        .api("/$batch")
        .post({ requests: chunk })) as GraphBatchResponse<TResponseBody>;

      const responses = response?.responses ?? [];
      const requestsById = new Map(
        chunk.map((request) => [request.id, request]),
      );

      responses.forEach((res) => {
        aggregatedResponses.push(res);
        if (res.status >= 400 && onFailure) {
          onFailure({
            request: requestsById.get(res.id),
            response: res,
          });
        }
      });
      if (shouldStop?.(responses)) break;
    } catch (error) {
      logger.error("Graph batch request failed", {
        ...context,
        chunkSize: chunk.length,
        error,
      });
      throw error;
    }
  }

  return aggregatedResponses;
}

/**
 * Reads full messages (body and attachment list) through Graph `$batch`.
 * Graph runs a batch's items concurrently, so each batch carries at most the
 * mailbox's concurrency limit. Messages Graph no longer has are left out.
 */
export async function getMessagesInBatches({
  client,
  messageIds,
  logger,
}: {
  client: OutlookClient;
  messageIds: string[];
  logger: Logger;
}): Promise<ParsedMessage[]> {
  const ids = [...new Set(messageIds)];
  if (ids.length === 0) return [];

  const query = new URLSearchParams({
    $select: MESSAGE_SELECT_FIELDS,
    $expand: MESSAGE_EXPAND_ATTACHMENTS,
  });
  const fetched = new Map<string, Message>();
  const missing = new Set<string>();

  // A retry after throttling asks only for what has not arrived yet.
  await withMicrosoftGraphRetry(async () => {
    const pending = ids.filter((id) => !fetched.has(id) && !missing.has(id));
    const responses = await batch<never, Message>({
      client,
      requests: pending.map((messageId, index) => ({
        id: String(index),
        method: "GET",
        url: `/me/messages/${encodeURIComponent(messageId)}?${query}`,
        // Batch items do not inherit the outer request's headers.
        headers: { Prefer: 'IdType="ImmutableId"' },
      })),
      chunkSize: MICROSOFT_MAILBOX_CONCURRENCY_LIMIT,
      context: { messageCount: pending.length },
      logger,
      shouldStop: (chunk) => chunk.some(isRetryableBatchFailure),
    });

    let retryableError: Error | undefined;
    for (const response of responses) {
      const messageId = pending[Number(response.id)];
      if (messageId === undefined) continue;
      if (response.status < 300) {
        if (response.body) fetched.set(messageId, response.body);
        continue;
      }
      if (response.status === 404) {
        missing.add(messageId);
        continue;
      }
      const error = toBatchItemError(response);
      if (!isRetryableBatchFailure(response)) throw error;
      retryableError ??= error;
    }
    if (retryableError) throw retryableError;
  }, logger);

  const [folderIds, categoryMap] = await Promise.all([
    getFolderIds(client, logger, { includeDrafts: false }),
    getCategoryMap(client, logger),
  ]);
  return ids.flatMap((messageId) => {
    const message = fetched.get(messageId);
    return message
      ? [convertMessage(message, folderIds, categoryMap, logger)]
      : [];
  });
}

export async function getThreadParticipantMessagesInBatches({
  client,
  threadIds,
  logger,
}: {
  client: OutlookClient;
  threadIds: string[];
  logger: Logger;
}): Promise<Map<string, Message[]>> {
  const requestIdToThreadId = new Map<string, string>();
  let requests = threadIds.map((threadId, index) => {
    const requestId = `thread-${index}`;
    requestIdToThreadId.set(requestId, threadId);

    const searchParams = new URLSearchParams({
      // Unsent drafts would otherwise appear as senders in thread names.
      $filter: `conversationId eq '${escapeODataString(threadId)}' and isDraft eq false`,
      $select: THREAD_PARTICIPANT_SELECT_FIELDS,
      $top: "100",
    });

    return {
      id: requestId,
      method: "GET",
      url: `/me/messages?${searchParams}`,
    };
  });

  const messagesByThreadId = new Map<string, Message[]>();
  const seenNextLinks = new Set<string>();

  while (requests.length) {
    const responses = await batch<
      never,
      { value?: Message[]; "@odata.nextLink"?: string }
    >({
      client,
      requests,
      logger,
      context: { threadCount: threadIds.length },
      onFailure: ({ request, response }) => {
        logger.warn("Failed to fetch Outlook thread participants", {
          threadId: request ? requestIdToThreadId.get(request.id) : undefined,
          status: response.status,
        });
      },
      shouldStop: (responses) =>
        responses.some((response) => response.status === 429),
    });
    const continuationRequests: typeof requests = [];

    for (const response of responses) {
      if (response.status >= 400) continue;

      const threadId = requestIdToThreadId.get(response.id);
      if (!threadId) continue;

      const messages = messagesByThreadId.get(threadId) ?? [];
      messages.push(...(response.body?.value ?? []));
      messagesByThreadId.set(threadId, messages);

      const nextLink = response.body?.["@odata.nextLink"];
      if (!nextLink || seenNextLinks.has(nextLink)) continue;

      seenNextLinks.add(nextLink);
      continuationRequests.push({
        id: response.id,
        method: "GET",
        url: toGraphBatchUrl(nextLink),
      });
    }

    if (responses.some((response) => response.status === 429)) break;

    requests = continuationRequests;
  }

  return messagesByThreadId;
}

async function moveMessagesInBatches({
  client,
  messageIds,
  destinationId,
  action,
  stopOnError = false,
  logger,
}: {
  client: OutlookClient;
  messageIds: string[];
  destinationId: string;
  action: "archive" | "trash";
  stopOnError?: boolean;
  logger: Logger;
}): Promise<MoveMessagesBatchResult> {
  if (messageIds.length === 0) {
    return { movedMessageIds: [], hasErrors: false };
  }

  const requestIdToMessageId = new Map<string, string>();
  const requests = messageIds.map((messageId, index) => {
    const requestId = `${action}-${index}`;
    requestIdToMessageId.set(requestId, messageId);

    return {
      id: requestId,
      method: "POST",
      url: `/me/messages/${messageId}/move`,
      headers: {
        "Content-Type": "application/json",
      },
      body: {
        destinationId,
      },
    };
  });

  const responses = await batch({
    client,
    requests,
    chunkSize: MICROSOFT_MAILBOX_CONCURRENCY_LIMIT,
    context: {
      action,
      destinationId,
      messageCount: messageIds.length,
    },
    logger,
    onFailure: ({ request, response }) => {
      const messageId = request ? requestIdToMessageId.get(request.id) : null;
      const body = response.body;
      const errorMessage =
        body && typeof body === "object" && body !== null && "error" in body
          ? (body as { error?: { message?: string } }).error?.message
          : body
            ? JSON.stringify(body)
            : undefined;

      const context = {
        action,
        messageId,
        status: response.status,
        error: errorMessage,
      };
      if (response.status === 429) {
        logger.warn("Failed to move message via batch", context);
      } else {
        logger.error("Failed to move message via batch", context);
      }
    },
    shouldStop: (responses) =>
      responses.some((response) => response.status === 429),
  });

  const movedMessageIds = responses.flatMap((response) => {
    if (response.status >= 400) return [];

    const messageId = requestIdToMessageId.get(response.id);
    return messageId ? [messageId] : [];
  });
  const hasErrors = responses.some((response) => response.status >= 400);

  if (hasErrors && stopOnError) {
    logger.error("Graph batch responses contain errors", {
      action,
      destinationId,
      errorCount: responses.filter((response) => response.status >= 400).length,
      messageCount: messageIds.length,
      statuses: responses
        .filter((response) => response.status >= 400)
        .map((response) => response.status),
    });
  }

  return {
    movedMessageIds,
    hasErrors,
  };
}

export async function moveThreadsInBatches({
  client,
  threads,
  destinationId,
  ownerEmail,
  logger,
}: {
  client: OutlookClient;
  threads: BulkArchiveThread[];
  destinationId: string;
  ownerEmail: string;
  logger: Logger;
}): Promise<BulkArchiveResult> {
  const messageIds = [
    ...new Set(threads.flatMap((thread) => thread.messageIds)),
  ];
  const { movedMessageIds } = await moveMessagesInBatches({
    client,
    messageIds,
    destinationId,
    action: "archive",
    logger,
  });
  const movedMessageIdSet = new Set(movedMessageIds);
  const succeededThreadIds = threads
    .filter(
      (thread) =>
        thread.messageIds.length > 0 &&
        thread.messageIds.every((messageId) =>
          movedMessageIdSet.has(messageId),
        ),
    )
    .map((thread) => thread.threadId);
  const succeededThreadIdSet = new Set(succeededThreadIds);
  const failedThreadIds = threads
    .map((thread) => thread.threadId)
    .filter((threadId) => !succeededThreadIdSet.has(threadId));

  if (succeededThreadIds.length > 0) {
    await publishBulkActionToTinybird({
      threadIds: succeededThreadIds,
      action: "archive",
      ownerEmail,
    });
  }

  return { succeededThreadIds, failedThreadIds };
}

export async function moveMessagesForSenders({
  client,
  senders,
  destinationId,
  action,
  ownerEmail,
  emailAccountId,
  continueOnError = true,
  logger,
}: {
  client: OutlookClient;
  senders: string[];
  destinationId: string;
  action: "archive" | "trash";
  ownerEmail: string;
  emailAccountId: string;
  continueOnError?: boolean;
  logger: Logger;
}): Promise<number> {
  if (senders.length === 0) return 0;

  // Resolve the actual inbox folder ID for archive filtering
  // parentFolderId on messages is the real folder ID (a GUID), not the well-known name
  let inboxFolderId: string | undefined;
  if (action === "archive") {
    const folderIds = await getFolderIds(client, logger, {
      includeDrafts: false,
    });
    inboxFolderId = folderIds.inbox;
    if (!inboxFolderId) {
      logger.error(
        "Could not resolve inbox folder ID — aborting bulk archive to avoid archiving from all folders",
      );
      if (!continueOnError) {
        throw new Error("Could not resolve inbox folder ID for bulk archive");
      }
      return 0;
    }
  }

  let movedMessagesCount = 0;

  for (const sender of senders) {
    if (!sender) continue;

    const processedMessageIds = new Set<string>();
    const publishedThreadIds = new Set<string>();
    const fromFilter = `from/emailAddress/address eq '${escapeODataString(sender)}'`;
    const filterExpression = inboxFolderId
      ? `${fromFilter} and parentFolderId eq '${escapeODataString(inboxFolderId)}'`
      : fromFilter;

    // Use @odata.nextLink directly for pagination instead of extracting $skiptoken
    // This is more reliable as Microsoft Graph may use different token formats
    // See: https://learn.microsoft.com/en-us/graph/paging
    let nextLink: string | undefined;

    // Helper to fetch a page of messages
    const fetchPage = async (url?: string) => {
      if (url) {
        // Use the full @odata.nextLink URL for subsequent pages
        return client.getClient().api(url).get();
      }
      // First page: use fluent API
      return client
        .getClient()
        .api("/me/messages")
        .filter(filterExpression)
        .top(100)
        .select("id,conversationId")
        .get();
    };

    // Process all pages
    do {
      try {
        const response: {
          value?: Array<{ id?: string | null; conversationId?: string | null }>;
          "@odata.nextLink"?: string;
        } = await fetchPage(nextLink);

        const allMessages = (response.value ?? []).filter(
          (message): message is { id: string; conversationId: string } =>
            !!message.id &&
            !!message.conversationId &&
            !processedMessageIds.has(message.id),
        );

        const messageIds = allMessages.map((msg) => msg.id);

        if (messageIds.length > 0) {
          try {
            const { movedMessageIds, hasErrors } = await moveMessagesInBatches({
              client,
              messageIds,
              destinationId,
              action,
              stopOnError: !continueOnError,
              logger,
            });

            const movedMessageIdSet = new Set(movedMessageIds);
            const batchThreadIds = new Set(
              allMessages
                .filter((message) => movedMessageIdSet.has(message.id))
                .map((message) => message.conversationId),
            );

            const newThreadIds = Array.from(batchThreadIds).filter(
              (threadId) => !publishedThreadIds.has(threadId),
            );

            const promises: Promise<unknown>[] = [];

            if (movedMessageIds.length > 0) {
              movedMessagesCount += movedMessageIds.length;
              promises.push(
                updateEmailMessagesForSender({
                  sender,
                  messageIds: movedMessageIds,
                  emailAccountId,
                  action,
                }),
              );
            }

            if (newThreadIds.length > 0) {
              promises.push(
                publishBulkActionToTinybird({
                  threadIds: newThreadIds,
                  action,
                  ownerEmail,
                }),
              );
            }

            await Promise.all(promises);

            newThreadIds.forEach((threadId) =>
              publishedThreadIds.add(threadId),
            );

            if (hasErrors && !continueOnError) {
              throw new Error(
                "Graph batch returned one or more error responses.",
              );
            }
          } catch (error) {
            logger.error("Failed to move or track messages", {
              action,
              ownerEmail,
              destinationId,
              messageIds,
              error,
            });
            if (!continueOnError) throw error;
          } finally {
            messageIds.forEach((id) => processedMessageIds.add(id));
          }
        }

        nextLink = response["@odata.nextLink"];
        logger.info("Pagination status", {
          processedCount: processedMessageIds.size,
          hasNextLink: !!nextLink,
        });
      } catch (error) {
        logger.error("Failed to fetch messages from sender", {
          action,
          error,
        });
        if (!continueOnError) throw error;
        nextLink = undefined;
      }
    } while (nextLink);
  }

  return movedMessagesCount;
}

function toGraphBatchUrl(nextLink: string): string {
  const resolvedNextLink = resolveMicrosoftGraphNextLink(nextLink);
  if (!resolvedNextLink) {
    throw new Error("Invalid Outlook participant page token");
  }

  const url = new URL(resolvedNextLink);
  const pathname = url.pathname.replace(/^\/(?:v1\.0|beta)(?=\/)/, "");
  return `${pathname}${url.search}`;
}

function isRetryableBatchFailure(response: GraphBatchResponseItem) {
  return (
    response.status >= 400 &&
    response.status !== 404 &&
    isRetryableError(extractErrorInfo(toBatchItemError(response))).retryable
  );
}

// Shaped like the Graph SDK's errors, so retry, rate-limit mode and the mail
// engine's throttling read the item's status, code and Retry-After as usual.
function toBatchItemError(response: GraphBatchResponseItem) {
  const graphError = (
    response.body as { error?: { code?: string; message?: string } } | null
  )?.error;
  return Object.assign(
    new Error(
      graphError?.message ||
        `Graph batch item failed with status ${response.status}`,
    ),
    {
      statusCode: response.status,
      code: graphError?.code,
      response: { headers: response.headers ?? {} },
    },
  );
}
