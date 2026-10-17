import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRequestDeadline } from "@/utils/request-deadline-reader";

// An email's triage shares its run's few minutes with the rest of the backlog.
// During a provider outage, retries and fallback models alone could take well
// over a minute per call, so each call gives up within this and the run stops
// before the email instead, leaving it for the next run.
const AUTOMATED_AI_CALL_BUDGET_MS = 45_000;

// Within a 300s function, with room to save progress before it is killed, so
// a call cut off there fails like any other call that ran out of time.
export const AUTOMATED_RUN_AI_DEADLINE_MS = 270_000;

const automatedWorkContext = new AsyncLocalStorage<{ runDeadlineAt: number }>();

/**
 * Runs work no one is waiting on, such as triaging incoming mail, so each AI
 * call it makes, with its retries and fallbacks, is bounded in time. Calls
 * also end by `runDeadlineAt` when the request has no deadline of its own.
 */
export function runWithAutomatedAiCallBound<T>(
  operation: () => Promise<T>,
  { runDeadlineAt }: { runDeadlineAt: number },
): Promise<T> {
  return automatedWorkContext.run({ runDeadlineAt }, operation);
}

/**
 * Starts one AI call's time bound: the request or run deadline, and when
 * `budgeted`, no later than the automated call budget. Undefined outside
 * automated work, where chat and other calls someone is waiting on keep their
 * own limits.
 */
export function startAutomatedAiCallBound({
  budgeted,
}: {
  budgeted: boolean;
}): { signal: AbortSignal; clear: () => void } | undefined {
  const store = automatedWorkContext.getStore();
  if (!store) return;

  const deadlineAt = Math.min(
    budgeted
      ? Date.now() + AUTOMATED_AI_CALL_BUDGET_MS
      : Number.POSITIVE_INFINITY,
    getRequestDeadline() ?? store.runDeadlineAt,
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

export function isAutomatedAiCallTimeoutError(
  error: unknown,
): error is AutomatedAiCallTimeoutError {
  return error instanceof AutomatedAiCallTimeoutError;
}
