import { AsyncLocalStorage } from "node:async_hooks";
import { setRequestDeadlineReader } from "@/utils/request-deadline-reader";

// Leaves room to send the answer, and for a provider call already in flight
// when the deadline passes, before the platform kills the function.
const MAX_DURATION_MARGIN_MS = 10_000;

const deadlineContext = new AsyncLocalStorage<{ deadlineAt?: number }>();

setRequestDeadlineReader(() => deadlineContext.getStore()?.deadlineAt);

/**
 * Runs a request someone is waiting on with a deadline derived from its
 * route's `maxDuration`. Provider retries and Gmail quota waits give up rather
 * than wait past it. Work the request leaves running once it settles, such as
 * `after()` callbacks, has no deadline: it shares this store, which is cleared.
 */
export async function runWithRequestDeadline<T>(
  maxDurationSeconds: number | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (maxDurationSeconds === undefined) return operation();
  const maxDurationMs = maxDurationSeconds * 1000;
  const store: { deadlineAt?: number } = {
    deadlineAt:
      Date.now() +
      Math.max(maxDurationMs - MAX_DURATION_MARGIN_MS, maxDurationMs / 2),
  };
  try {
    return await deadlineContext.run(store, operation);
  } finally {
    store.deadlineAt = undefined;
  }
}
