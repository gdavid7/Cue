import type { Logger } from "@/utils/logger";

const LOG_INTERVAL_MS = 5 * 60_000;

declare global {
  var redisUsageMeter: ReturnType<typeof createRedisUsageMeter> | undefined;
}

/**
 * Counts this instance's Redis commands and the bytes they read, by feature
 * (a key's prefix), without any Redis traffic of its own. A summary is
 * logged from request flushes at most every few minutes, so Axiom can sum
 * commands and bandwidth per feature per day, and per active user.
 */
export function createRedisUsageMeter() {
  let counts = new Map<string, { commands: number; bytesRead: number }>();
  let since = Date.now();

  const count = (_command: string, key: unknown, bytesRead = 0) => {
    const feature = featureOf(key);
    const entry = counts.get(feature) ?? { commands: 0, bytesRead: 0 };
    entry.commands += 1;
    entry.bytesRead += bytesRead;
    counts.set(feature, entry);
  };

  return {
    count,
    /** Counts every call on `client`, keeping its methods otherwise intact. */
    wrap<T extends object>(client: T): T {
      return new Proxy(client, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver);
          if (typeof value !== "function" || typeof property !== "string")
            return value;
          return (...args: unknown[]) => {
            const result = value.apply(target, args);
            // eval(script, keys, args): its first key names the feature.
            const key = property.startsWith("eval")
              ? (args[1] as unknown[] | undefined)?.[0]
              : args[0];
            if (!(result instanceof Promise)) {
              count(property, key);
              return result;
            }
            return result.then((resolved: unknown) => {
              count(property, key, sizeOf(resolved));
              return resolved;
            });
          };
        },
      });
    },
    snapshot() {
      return [...counts.entries()].map(([feature, entry]) => ({
        feature,
        ...entry,
      }));
    },
    logSummary(logger: Pick<Logger, "info">) {
      const now = Date.now();
      if (now - since < LOG_INTERVAL_MS || counts.size === 0) return;
      const byFeature = [...counts.entries()]
        .map(([feature, entry]) => ({ feature, ...entry }))
        .sort((a, b) => b.commands - a.commands);
      logger.info("Redis usage", {
        intervalSeconds: Math.round((now - since) / 1000),
        commands: byFeature.reduce((sum, entry) => sum + entry.commands, 0),
        bytesRead: byFeature.reduce((sum, entry) => sum + entry.bytesRead, 0),
        byFeature,
      });
      counts = new Map();
      since = now;
    },
  };
}

// One per instance: every command through `redis` and the shared subscriber.
export function getRedisUsageMeter() {
  global.redisUsageMeter ??= createRedisUsageMeter();
  return global.redisUsageMeter;
}

function featureOf(key: unknown) {
  if (typeof key !== "string") return "other";
  const separator = key.indexOf(":");
  return (separator === -1 ? key : key.slice(0, separator)).slice(0, 40);
}

function sizeOf(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value).length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}
