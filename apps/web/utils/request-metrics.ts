import { AsyncLocalStorage } from "node:async_hooks";

type Dependency = "auth" | "db" | "redis" | "provider";

export type RequestMetrics = Record<Dependency, { ms: number; calls: number }>;

const metricsContext = new AsyncLocalStorage<RequestMetrics>();

/**
 * Collects how long a request spends waiting on its dependencies. Durations
 * are summed per call, so concurrent calls add up to more than the wall
 * time. Work started outside the request (cron, `after()` callbacks that
 * outlive it) records nothing once the store is gone.
 */
export function createRequestMetrics(): RequestMetrics {
  return {
    auth: { ms: 0, calls: 0 },
    db: { ms: 0, calls: 0 },
    redis: { ms: 0, calls: 0 },
    provider: { ms: 0, calls: 0 },
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
    addRequestDependencyTime(
      dependency,
      performance.now() - startedAt,
      metrics,
    );
  }
}

export function addRequestDependencyTime(
  dependency: Dependency,
  ms: number,
  metrics = metricsContext.getStore(),
) {
  if (!metrics) return;
  metrics[dependency].ms += ms;
  metrics[dependency].calls += 1;
}

export function getRequestMetricsFields(metrics: RequestMetrics) {
  return {
    authMs: Math.round(metrics.auth.ms),
    dbMs: Math.round(metrics.db.ms),
    dbCalls: metrics.db.calls,
    redisMs: Math.round(metrics.redis.ms),
    redisCalls: metrics.redis.calls,
    providerMs: Math.round(metrics.provider.ms),
    providerCalls: metrics.provider.calls,
  };
}
