import type { ModelMessage } from "ai";
import type { MatchingBulkAction } from "@/utils/actions/mail-bulk-matching.validation";
import {
  countWithProvider,
  toMatchingScope,
} from "@/utils/ai/assistant/chat-count-tools";
import type { ManageInboxAction } from "@/utils/ai/assistant/manage-inbox-actions";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { filterForAction } from "@/utils/mail-bulk/run-matching-job";
import { startMatchingBulkJob } from "@/utils/mail-bulk/start-matching-job";

// The preview counts what the job would change, at one provider listing call
// per 500 messages; past this it says "at least".
const PREVIEW_MAX_MESSAGES = 10_000;

/** manageInbox actions that can run over every email a search matches. */
export const MATCHING_QUERY_ACTIONS = [
  "archive_threads",
  "mark_read_threads",
  "label_threads",
] as const satisfies readonly ManageInboxAction[];

export function supportsMatchingQuery(action: ManageInboxAction) {
  return (MATCHING_QUERY_ACTIONS as readonly string[]).includes(action);
}

/** The inbox job that runs a manageInbox action over a whole search. */
export function toMatchingBulkAction(
  action: ManageInboxAction,
  read: boolean | null | undefined,
): MatchingBulkAction | null {
  switch (action) {
    case "archive_threads":
      return "archive";
    case "mark_read_threads":
      return read === false ? "mark_unread" : "mark_read";
    case "label_threads":
      return "label";
    default:
      return null;
  }
}

type MatchingRequest = {
  /** The action as the model named it, which the preview echoes. */
  originalAction: string;
  query: string;
  labelName?: string | null;
  read?: boolean | null;
};

/**
 * Runs a manageInbox action over every email a search matches in the chat's
 * own account. The first call only counts what would change. The job starts
 * only when an earlier turn previewed this same action and search and the
 * user has written since, so the count was shown before anything changes,
 * whatever the model does. The job, its progress and its undo are the
 * inbox's own select-all job.
 */
export async function runMatchingQueryAction({
  request,
  bulkAction,
  labelId,
  emailProvider,
  emailAccountId,
  messages,
  logger,
  abortSignal,
}: {
  request: MatchingRequest;
  bulkAction: MatchingBulkAction;
  labelId?: string;
  emailProvider: EmailProvider;
  emailAccountId: string;
  /** The conversation so far, as the tool call received it. */
  messages: ModelMessage[];
  logger: Logger;
  abortSignal?: AbortSignal;
}) {
  const { scope } = toMatchingScope({ query: request.query });
  const preview = findConfirmedPreview(messages, request);

  if (!preview) {
    const counted = await countWithProvider({
      emailProvider,
      scope,
      only: filterForAction(bulkAction),
      maxMessages: PREVIEW_MAX_MESSAGES,
      abortSignal,
    });
    if (counted.total === 0) {
      return {
        status: "nothing_to_change" as const,
        action: request.originalAction,
        query: request.query,
        conversations: 0,
      };
    }
    return {
      status: "needs_confirmation" as const,
      action: request.originalAction,
      query: request.query,
      conversations: counted.conversations,
      messages: counted.total,
      ...(counted.capped ? { atLeast: true } : {}),
      nextStep:
        "Nothing has changed yet. Tell the user how many conversations this would change and ask them to confirm. Only after they confirm, call manageInbox again with the same action, query and label.",
    };
  }

  const jobId = await startMatchingBulkJob({
    emailAccountId,
    scope,
    action: bulkAction,
    labelId,
    logger,
  });
  return {
    status: "started" as const,
    action: request.originalAction,
    query: request.query,
    jobId,
    ...(preview.conversations !== undefined
      ? { conversations: preview.conversations }
      : {}),
  };
}

/**
 * The preview of this same request from an earlier turn, if the user has
 * written since it was shown. A preview from this turn doesn't count: the
 * user hasn't seen it yet.
 */
export function findConfirmedPreview(
  messages: ModelMessage[],
  request: MatchingRequest,
): { conversations?: number } | null {
  const lastUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const previewCalls = new Set<string>();

  for (let index = 0; index < lastUserIndex; index++) {
    const message = messages[index];
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (
          part.type === "tool-call" &&
          part.toolName === "manageInbox" &&
          isSameRequest(part.input, request)
        )
          previewCalls.add(part.toolCallId);
      }
    }
  }

  let found: { conversations?: number } | null = null;
  for (let index = 0; index < lastUserIndex; index++) {
    const message = messages[index];
    if (message.role !== "tool") continue;
    for (const part of message.content) {
      if (part.type !== "tool-result" || !previewCalls.has(part.toolCallId))
        continue;
      const value =
        part.output.type === "json" ? (part.output.value as unknown) : null;
      if (!isRecord(value) || value.status !== "needs_confirmation") continue;
      found = {
        conversations:
          typeof value.conversations === "number"
            ? value.conversations
            : undefined,
      };
    }
  }
  return found;
}

function isSameRequest(input: unknown, request: MatchingRequest) {
  if (!isRecord(input)) return false;
  const labelName = input.labelName ?? input.categoryName;
  return (
    input.action === request.originalAction &&
    normalizeText(input.query) === normalizeText(request.query) &&
    normalizeText(labelName) === normalizeText(request.labelName) &&
    (input.read ?? null) === (request.read ?? null)
  );
}

function normalizeText(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
