import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestDeadline } from "@/utils/request-deadline-reader";

// An email's triage shares its run's few minutes with the rest of the backlog.
// During a provider outage, retries and fallback models alone could take well
// over a minute per call, so each call gives up within this and the run stops
// before the email instead, leaving it for the next run.
const AUTOMATED_AI_CALL_BUDGET_MS = 45_000;

const automatedWorkContext = new AsyncLocalStorage<true>();

/**
 * Runs work no one is waiting on, such as triaging incoming mail, so each AI
 * call it makes, with its retries and fallbacks, is bounded in time.
 */
export function runWithAutomatedAiCallBound<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return automatedWorkContext.run(true, operation);
}

/**
 * Starts one AI call's time bound, ending at the request deadline if that
 * comes sooner. Undefined outside automated work: chat and other calls someone
 * is waiting on keep their own limits.
 */
export function startAutomatedAiCallBound():
  | { signal: AbortSignal; clear: () => void }
  | undefined {
  if (!automatedWorkContext.getStore()) return;

  const deadlineAt = Math.min(
    Date.now() + AUTOMATED_AI_CALL_BUDGET_MS,
    getRequestDeadline() ?? Number.POSITIVE_INFINITY,
  );
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(0, deadlineAt - Date.now()),
  );
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

export class AutomatedAiCallTimeoutError extends Error {
  constructor(label: string, cause: unknown) {
    super(`AI call ran out of time: ${label}`, { cause });
    this.name = "AutomatedAiCallTimeoutError";
  }
}

export function isAutomatedAiCallTimeoutError(error: unknown) {
  return error instanceof AutomatedAiCallTimeoutError;
}
