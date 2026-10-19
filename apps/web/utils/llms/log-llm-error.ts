import { JSONParseError } from "@ai-sdk/provider";
import { NoObjectGeneratedError, RetryError, TypeValidationError } from "ai";
import type { Logger } from "@/utils/logger";

const MAX_DEPTH = 5;

/**
 * Logs an LLM failure. AI SDK parse and validation errors carry the model's
 * raw output, which can echo email content, so above trace level they log only
 * the error name; the full error goes to trace. Other errors log as given.
 */
export function logLlmError(
  logger: Logger,
  level: "warn" | "error",
  message: string,
  fields: Record<string, unknown>,
  error: unknown,
) {
  const modelOutputError = findModelOutputError(error);
  if (!modelOutputError) {
    logger[level](message, { ...fields, error });
    return;
  }

  logger[level](message, {
    ...fields,
    errorName: modelOutputError.name,
    finishReason: NoObjectGeneratedError.isInstance(modelOutputError)
      ? modelOutputError.finishReason
      : undefined,
  });
  logger.trace(`${message} (full error)`, { ...fields, error });
}

function findModelOutputError(error: unknown, depth = 0): Error | undefined {
  if (depth > MAX_DEPTH || !error || typeof error !== "object") return;
  if (
    JSONParseError.isInstance(error) ||
    TypeValidationError.isInstance(error) ||
    NoObjectGeneratedError.isInstance(error)
  ) {
    return error;
  }

  const { cause, lastError, error: inner } = error as Record<string, unknown>;
  const retryErrors = RetryError.isInstance(error) ? error.errors : [];
  for (const nested of [cause, lastError, inner, ...retryErrors]) {
    const found = findModelOutputError(nested, depth + 1);
    if (found) return found;
  }
}
