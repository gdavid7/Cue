import { AsyncLocalStorage } from "node:async_hooks";

type Dependency = "auth" | "db" | "redis" | "gmail" | "gmailBatch" | "wait";

type Pause = { source: string; reason: string; retryAfterMs: number };

type EnumerationPage = {
  scope: "primary" | "history";
  phase: "inbox" | "rest" | "none";
  gatePriority: "sync" | "background";
  promoted: boolean;
};

export type RequestMetrics = Record<
  Dependency,
  { ms: number; calls: number }
> & {
  /** Gmail calls the quota gate deferred rather than admitted. */
  gmailDeferred: number;
  pause?: Pause;
  enumeration?: EnumerationPage;
  /** Wall time of named steps inside the handler; see `timeRequestPhase`. */
  phases: Record<string, number>;
};

const metricsContext = new AsyncLocalStorage<RequestMetrics>();

/**
 * Collects how long a request spends waiting on its dependencies. Durations
 * are summed per call, so concurrent calls overlap and can add up to more
 * than the request's wall time. `gmail` covers only Gmail REST calls, not
 * Outlook; `gmailBatch` is the multipart batch fetch. `wait` is time spent
 * deliberately idle (quota-gate sleeps, in-flight slot queues, retry
 * backoff), so a request's time can be explained rather than guessed. The store follows async work started in the request, so `after()`
 * callbacks keep adding to it once the "Request completed" line has been
 * logged; those later calls are not in that line.
 */
export function createRequestMetrics(): RequestMetrics {
  return {
    auth: { ms: 0, calls: 0 },
    db: { ms: 0, calls: 0 },
    redis: { ms: 0, calls: 0 },
    gmail: { ms: 0, calls: 0 },
    gmailBatch: { ms: 0, calls: 0 },
    wait: { ms: 0, calls: 0 },
    gmailDeferred: 0,
    phases: {},
  };
}

export function runWithRequestMetrics<T>(
  metrics: RequestMetrics,
  operation: () => T,
): T {
  return metricsContext.run(metrics, operation);
}

export async function timeRequestDependency<T>(
  dependency: Dependency,
  operation: () => Promise<T>,
): Promise<T> {
  const metrics = metricsContext.getStore();
  if (!metrics) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    metrics[dependency].ms += performance.now() - startedAt;
    metrics[dependency].calls += 1;
  }
}

/**
 * Times a named step of the handler, so the part of a request that no
 * dependency bucket explains shows up as `phaseMs.<name>` on its "Request
 * completed" line. Steps that run together overlap, so they can add up to
 * more than the request's time; a repeated name adds up.
 */
export async function timeRequestPhase<T>(
  name: string,
  operation: () => Promise<T>,
): Promise<T> {
  const metrics = metricsContext.getStore();
  if (!metrics) return operation();
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    metrics.phases[name] =
      (metrics.phases[name] ?? 0) + (performance.now() - startedAt);
  }
}

/** Records why this request answered "paused", for its "Request completed" line. */
export function noteRequestPause(pause: Pause) {
  const metrics = metricsContext.getStore();
  if (metrics) metrics.pause = pause;
}

/**
 * Counts a Gmail call the quota gate deferred, so the request's line says
 * whether it answered with less, or with a retry time, for lack of budget.
 */
export function noteGmailDeferral() {
  const metrics = metricsContext.getStore();
  if (metrics) metrics.gmailDeferred += 1;
}

/** Tells the "Request completed" line which kind of enumeration page this was. */
export function noteEnumerationPage(page: EnumerationPage) {
  const metrics = metricsContext.getStore();
  if (metrics) metrics.enumeration = page;
}

export function getRequestMetricsFields(metrics: RequestMetrics) {
  return {
    authMs: Math.round(metrics.auth.ms),
    dbMs: Math.round(metrics.db.ms),
    dbCalls: metrics.db.calls,
    redisMs: Math.round(metrics.redis.ms),
    redisCalls: metrics.redis.calls,
    gmailMs: Math.round(metrics.gmail.ms),
    gmailCalls: metrics.gmail.calls,
    gmailBatchMs: Math.round(metrics.gmailBatch.ms),
    gmailBatchCalls: metrics.gmailBatch.calls,
    waitMs: Math.round(metrics.wait.ms),
    gmailDeferredCalls: metrics.gmailDeferred,
    pausedSource: metrics.pause?.source,
    pausedReason: metrics.pause?.reason,
    pausedRetryAfterMs: metrics.pause?.retryAfterMs,
    scope: metrics.enumeration?.scope,
    phase: metrics.enumeration?.phase,
    gatePriority: metrics.enumeration?.gatePriority,
    promoted: metrics.enumeration?.promoted,
    phaseMs: Object.keys(metrics.phases).length
      ? Object.fromEntries(
          Object.entries(metrics.phases).map(([name, ms]) => [
            name,
            Math.round(ms),
          ]),
        )
      : undefined,
  };
}
