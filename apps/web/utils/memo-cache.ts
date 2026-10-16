/**
 * A small per-instance cache for values read on most requests (who owns an
 * account, whether it is rate limited), so each instance asks Redis or the
 * database at most once per `ttlMs` per key. Concurrent callers share a
 * load; failed loads are not kept. Oldest entries go first past `maxEntries`.
 */
export function createMemoCache<T>({
  ttlMs,
  maxEntries,
  keep = () => true,
}: {
  ttlMs: number;
  maxEntries: number;
  keep?: (value: T) => boolean;
}) {
  const entries = new Map<string, { value: Promise<T>; expiresAt: number }>();

  const set = (key: string, value: Promise<T>) => {
    entries.delete(key);
    entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    if (entries.size > maxEntries) {
      const oldest = entries.keys().next().value;
      if (oldest !== undefined) entries.delete(oldest);
    }
  };

  return {
    get(key: string, load: () => Promise<T>): Promise<T> {
      const entry = entries.get(key);
      if (entry && entry.expiresAt > Date.now()) return entry.value;
      const value = load();
      set(key, value);
      value.then(
        (loaded) => {
          if (!keep(loaded) && entries.get(key)?.value === value)
            entries.delete(key);
        },
        () => {
          if (entries.get(key)?.value === value) entries.delete(key);
        },
      );
      return value;
    },
    set(key: string, value: T) {
      set(key, Promise.resolve(value));
    },
    delete(key: string) {
      entries.delete(key);
    },
  };
}
