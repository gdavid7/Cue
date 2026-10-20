import { AsyncLocalStorage } from "node:async_hooks";

type Dependency = "auth" | "db" | "redis" | "gmail";

export type RequestMetrics = Record<Dependency, { ms: number; calls: number }>;

const metricsContext = new AsyncLocalStorage<RequestMetrics>();

/**
 * Collects how long a request spends waiting on its dependencies. Durations
 * are summed per call, so concurrent calls overlap and can add up to more
 * than the request's wall time. `gmail` covers only Gmail REST calls, not
 * Outlook. The store follows async work started in the request, so `after()`
 * callbacks keep adding to it once the "Request completed" line has been
 * logged; those later calls are not in that line.
 */
export function createRequestMetrics(): RequestMetrics {
  return {
    auth: { ms: 0, calls: 0 },
    db: { ms: 0, calls: 0 },
    redis: { ms: 0, calls: 0 },
    gmail: { ms: 0, calls: 0 },
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

export function getRequestMetricsFields(metrics: RequestMetrics) {
  return {
    authMs: Math.round(metrics.auth.ms),
    dbMs: Math.round(metrics.db.ms),
    dbCalls: metrics.db.calls,
    redisMs: Math.round(metrics.redis.ms),
    redisCalls: metrics.redis.calls,
    gmailMs: Math.round(metrics.gmail.ms),
    gmailCalls: metrics.gmail.calls,
  };
}
