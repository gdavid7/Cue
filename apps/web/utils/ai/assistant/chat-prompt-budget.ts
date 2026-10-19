import type { ModelMessage, ToolResultPart } from "ai";
import { estimateMessageTokens } from "@/utils/ai/assistant/prompt-size";
import { shortenToolResult } from "@/utils/ai/assistant/trim-stale-tool-results";

// Every chat step re-sends the whole prompt, and some models bill a request
// at a higher rate once its prompt passes 100K tokens, so a chat step stays
// under that however long the conversation or the tool loop gets.
export const CHAT_PROMPT_TOKEN_LIMIT = 100_000;
// Aiming below the limit leaves room for the estimate's error.
const PROMPT_TOKEN_BUDGET = 92_000;

export const OMITTED_HISTORY_NOTE =
  "[Automated context — not a message from the user] Earlier messages in this chat were left out to stay within the context limit.";
const REMOVED_RESULT_NOTE =
  "Result removed to stay within the context limit. Run the tool again if it is still needed.";

export type PromptBudgetStage =
  | "shortened_earlier_results"
  | "dropped_history"
  | "shortened_latest_results"
  | "removed_earlier_results"
  | "removed_latest_results"
  | "over_budget";

/**
 * Brings a chat step's prompt under the token budget, giving up the least
 * useful context first: earlier tool results are shortened, then the oldest
 * conversation turns are dropped, then the latest results are shortened, and
 * last any tool result is replaced by a note. A prompt that already fits is
 * returned as it is. `fixedTokens` counts what the messages do not hold, such
 * as the tool definitions. `historyEndIndex` is the index of the last message
 * from earlier turns; it moves when history is dropped.
 */
export function fitPromptToBudget({
  messages,
  fixedTokens,
  historyEndIndex,
  budgetTokens = PROMPT_TOKEN_BUDGET,
}: {
  messages: ModelMessage[];
  fixedTokens: number;
  historyEndIndex: number;
  budgetTokens?: number;
}): {
  messages: ModelMessage[];
  historyEndIndex: number;
  stage?: PromptBudgetStage;
  estimatedTokens: number;
} {
  const fits = (candidate: ModelMessage[]) =>
    fixedTokens + estimateMessageTokens(candidate) <= budgetTokens;
  const result = (
    candidate: ModelMessage[],
    endIndex: number,
    stage?: PromptBudgetStage,
  ) => ({
    messages: candidate,
    historyEndIndex: endIndex,
    stage,
    estimatedTokens: fixedTokens + estimateMessageTokens(candidate),
  });

  if (fits(messages)) return result(messages, historyEndIndex);

  const latestToolIndex = messages.findLastIndex(
    (message) => message.role === "tool",
  );

  let current = mapToolResults(messages, (part, index) =>
    index === latestToolIndex ? part : shortenToolResult(part),
  );
  if (fits(current)) {
    return result(current, historyEndIndex, "shortened_earlier_results");
  }

  let endIndex = historyEndIndex;
  for (const dropped of dropOldestTurns(current, historyEndIndex)) {
    current = dropped.messages;
    endIndex = dropped.historyEndIndex;
    if (fits(current)) return result(current, endIndex, "dropped_history");
  }

  const stages: Array<{
    stage: PromptBudgetStage;
    transform: (part: ToolResultPart, isLatest: boolean) => ToolResultPart;
  }> = [
    {
      stage: "shortened_latest_results",
      transform: (part) => shortenToolResult(part),
    },
    {
      stage: "removed_earlier_results",
      transform: (part, isLatest) => (isLatest ? part : removeResult(part)),
    },
    { stage: "removed_latest_results", transform: removeResult },
  ];

  const currentLatestToolIndex = current.findLastIndex(
    (message) => message.role === "tool",
  );
  for (const { stage, transform } of stages) {
    current = mapToolResults(current, (part, index) =>
      transform(part, index === currentLatestToolIndex),
    );
    if (fits(current)) return result(current, endIndex, stage);
  }

  return result(current, endIndex, "over_budget");
}

// Drops whole turns, oldest first, so a tool call never loses its result.
// The dropped turns are replaced by one note, kept across later steps.
function* dropOldestTurns(messages: ModelMessage[], historyEndIndex: number) {
  const hasNote = isOmittedHistoryNote(messages[1]);
  const historyStart = hasNote ? 2 : 1;
  if (historyEndIndex < historyStart) return;

  const turnStarts: number[] = [];
  for (let index = historyStart + 1; index <= historyEndIndex; index++) {
    if (messages[index]?.role === "user") turnStarts.push(index);
  }
  turnStarts.push(historyEndIndex + 1);

  const note: ModelMessage = { role: "user", content: OMITTED_HISTORY_NOTE };
  for (const keepFrom of turnStarts) {
    const kept = messages.slice(keepFrom, historyEndIndex + 1);
    yield {
      messages: [
        messages[0],
        note,
        ...kept,
        ...messages.slice(historyEndIndex + 1),
      ],
      historyEndIndex: 1 + kept.length,
    };
  }
}

function isOmittedHistoryNote(message: ModelMessage | undefined) {
  return message?.role === "user" && message.content === OMITTED_HISTORY_NOTE;
}

function mapToolResults(
  messages: ModelMessage[],
  transform: (part: ToolResultPart, messageIndex: number) => ToolResultPart,
) {
  return messages.map((message, index): ModelMessage => {
    if (message.role !== "tool") return message;

    return {
      ...message,
      content: message.content.map((part) =>
        part.type === "tool-result" ? transform(part, index) : part,
      ),
    };
  });
}

function removeResult(part: ToolResultPart): ToolResultPart {
  return { ...part, output: { type: "text", value: REMOVED_RESULT_NOTE } };
}
