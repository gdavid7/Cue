import type { ModelMessage, ToolResultPart } from "ai";

// Latin-script text and JSON run at close to three characters per token on
// newer Claude tokenizers, so ASCII is counted a little under that. CJK and
// most other non-ASCII characters can cost a token or more each, so each one
// counts as a whole token.
const ASCII_CHARS_PER_TOKEN = 2.75;
const IMAGE_TOKEN_ESTIMATE = 1600;
const MESSAGE_OVERHEAD_TOKENS = 4;

export function estimateTextTokens(text: string): number {
  let nonAscii = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) > 127) nonAscii++;
  }
  return Math.ceil((text.length - nonAscii) / ASCII_CHARS_PER_TOKEN + nonAscii);
}

export function estimateMessageTokens(messages: ModelMessage[]): number {
  return messages.reduce(
    (total, message) => total + estimateSingleMessageTokens(message),
    0,
  );
}

export function getToolOutputText(output: ToolResultPart["output"]): string {
  if ("value" in output && typeof output.value === "string") {
    return output.value;
  }

  return JSON.stringify("value" in output ? output.value : output);
}

export function truncatePromptContent(
  content: string,
  maxChars: number,
): string {
  if (content.length <= maxChars) return content;

  const suffix = "... [truncated]";
  if (maxChars <= suffix.length) {
    return content.slice(0, maxChars).trimEnd();
  }
  const prefixLength = maxChars - suffix.length;

  return `${content.slice(0, prefixLength).trimEnd()}${suffix}`;
}

function estimateSingleMessageTokens(message: ModelMessage): number {
  if (typeof message.content === "string") {
    return estimateTextTokens(message.content) + MESSAGE_OVERHEAD_TOKENS;
  }

  let tokens = MESSAGE_OVERHEAD_TOKENS;
  for (const part of message.content) {
    switch (part.type) {
      case "text":
      case "reasoning":
        tokens += estimateTextTokens(part.text);
        break;
      case "tool-call":
        tokens += estimateTextTokens(
          part.toolName + JSON.stringify(part.input ?? {}),
        );
        break;
      case "tool-result":
        tokens += estimateTextTokens(
          part.toolName + getToolOutputText(part.output),
        );
        break;
      case "image":
      case "file":
        tokens += IMAGE_TOKEN_ESTIMATE;
        break;
      default:
        tokens += estimateTextTokens(JSON.stringify(part));
    }
  }
  return tokens;
}
