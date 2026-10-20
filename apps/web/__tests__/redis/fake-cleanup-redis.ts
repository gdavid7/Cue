import type { CleanupRedis } from "@/utils/redis/pii-cache-keys";

/**
 * An in-memory Redis for the PII cleanup. Like Redis, a scan returns every
 * key present when it started, even while keys are deleted along the way, and
 * RENAMENX on a missing source fails the way the Upstash client reports it.
 */
export function fakeCleanupRedis(
  initial: Record<string, unknown> = {},
  pageSize?: number,
) {
  const store = new Map(Object.entries(initial));
  let snapshot: string[] = [];
  let scans = 0;

  const client: CleanupRedis = {
    async scan(cursor, { match, count }) {
      scans++;
      const pattern = new RegExp(
        `^${match.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`,
      );
      const start = Number(cursor);
      if (start === 0)
        snapshot = [...store.keys()].filter((key) => pattern.test(key)).sort();
      const size = pageSize ?? count;
      const next = start + size >= snapshot.length ? 0 : start + size;
      return [String(next), snapshot.slice(start, start + size)];
    },
    async get(key) {
      return store.get(key) ?? null;
    },
    async mget(...keys) {
      return keys.map((key) => store.get(key) ?? null);
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
    async unlink(...keys) {
      return keys.filter((key) => store.delete(key)).length;
    },
    async renamenx(source, destination) {
      if (!store.has(source))
        throw new Error(
          `ERR no such key, command was: ${JSON.stringify(["RENAMENX", source, destination])}`,
        );
      if (store.has(destination)) return 0;
      store.set(destination, store.get(source));
      store.delete(source);
      return 1;
    },
  };

  return {
    client,
    store,
    reset() {
      store.clear();
      snapshot = [];
      scans = 0;
    },
    get scans() {
      return scans;
    },
  };
}
