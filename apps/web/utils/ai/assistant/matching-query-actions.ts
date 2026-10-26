import type { ModelMessage } from "ai";
import type { MatchingBulkAction } from "@/utils/actions/mail-bulk-matching.validation";
import { isMicrosoftProvider } from "@/utils/email/provider-types";

// manageInbox actions that can run over every email a search matches, by the
// name each provider's manageInbox gives them. Trash has no confirm-and-undo
// flow here, so it stays thread by thread.
const MATCHING_QUERY_ACTIONS = {
  google: ["archive_threads", "mark_read_threads", "label_threads"],
  microsoft: ["archive_threads", "mark_read_threads", "categorize_threads"],
} as const;

export function getMatchingQueryActions(provider: string): readonly string[] {
  return isMicrosoftProvider(provider)
    ? MATCHING_QUERY_ACTIONS.microsoft
    : MATCHING_QUERY_ACTIONS.google;
}

/**
 * The select-all job a manageInbox action over a search runs as, or null for
 * an action that can't run over a search. Takes either provider's action name.
 */
export function toMatchingBulkAction(
  action: unknown,
  read: unknown,
): MatchingBulkAction | null {
  switch (action) {
    case "archive_threads":
      return "archive";
    case "mark_read_threads":
      return read === false ? "mark_unread" : "mark_read";
    case "label_threads":
    case "categorize_threads":
      return "label";
    default:
      return null;
  }
}

/** A manageInbox result as the model sees it: without the card's confirm token. */
export function withoutConfirmToken(output: unknown): unknown {
  if (
    typeof output !== "object" ||
    output === null ||
    !("confirmToken" in output)
  )
    return output;
  const { confirmToken: _confirmToken, ...rest } = output as Record<
    string,
    unknown
  >;
  return rest;
}

/**
 * Stored chat history as model messages, with every manageInbox confirm token
 * removed, for whatever reads the conversation (the model, memory extraction).
 */
export function withoutConfirmTokens(messages: ModelMessage[]): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" &&
        part.toolName === "manageInbox" &&
        part.output.type === "json"
          ? {
              ...part,
              output: {
                ...part.output,
                value: withoutConfirmToken(
                  part.output.value,
                ) as typeof part.output.value,
              },
            }
          : part,
      ),
    };
  });
}
