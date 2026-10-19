/**
 * An in-memory stand-in for `@/utils/redis` that keeps every value written
 * and every message published, so a test can check that nothing personal
 * reached the server cache:
 *
 *   vi.mock("@/utils/redis", async () => ({
 *     redis: (await import("@/__tests__/mocks/recording-redis.mock"))
 *       .recordingRedis.client,
 *   }));
 */
type SetOptions = { ex?: number; px?: number; nx?: boolean };

function createRecordingRedis() {
  const store = new Map<string, unknown>();
  const writes: { key: string; value: unknown }[] = [];
  const published: { channel: string; message: string }[] = [];

  const set = async (key: string, value: unknown, options?: SetOptions) => {
    if (options?.nx && store.has(key)) return null;
    store.set(key, value);
    writes.push({ key, value });
    return "OK";
  };

  const client = {
    get: async (key: string) => store.get(key) ?? null,
    mget: async (...keys: string[]) =>
      keys.map((key) => store.get(key) ?? null),
    set,
    del: async (...keys: string[]) =>
      keys.filter((key) => store.delete(key)).length,
    publish: async (channel: string, message: string) => {
      published.push({ channel, message });
      return 0;
    },
    pipeline: () => {
      const queued: (() => Promise<unknown>)[] = [];
      const pipeline = {
        set: (key: string, value: unknown, options?: SetOptions) => {
          queued.push(() => set(key, value, options));
          return pipeline;
        },
        exec: async () => Promise.all(queued.map((run) => run())),
      };
      return pipeline;
    },
  };

  return {
    client,
    store,
    writes,
    published,
    /** Every key, value and message that reached Redis, as one string. */
    everythingWritten() {
      return JSON.stringify({ writes, published });
    },
    reset() {
      store.clear();
      writes.length = 0;
      published.length = 0;
    },
  };
}

export const recordingRedis = createRecordingRedis();
