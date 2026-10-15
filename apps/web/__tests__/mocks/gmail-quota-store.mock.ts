import type { GmailQuotaStore } from "@/utils/gmail/quota-store";

/**
 * In-memory stand-in for the Redis quota store, following the same bucket
 * arithmetic as its Lua scripts on the (fakeable) `Date.now()` clock.
 */
export function createMemoryGmailQuotaStore(): GmailQuotaStore & {
  reset(): void;
} {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const blocks = new Map<string, number>();
  const usage = new Map<string, Record<string, number>>();
  const claimed = new Set<string>();
  const ttl = (key: string) => Math.max(0, (blocks.get(key) ?? 0) - Date.now());

  return {
    async take(input) {
      const now = Date.now();
      let wait = Math.max(
        0,
        ...input.blockers.map(({ key, pollMs }) =>
          pollMs ? Math.min(ttl(key), pollMs) : ttl(key),
        ),
      );
      const rate = input.perMinute / 60_000;
      const stored = buckets.get(input.bucketKey);
      const tokens = Math.min(
        input.capacity,
        (stored?.tokens ?? input.capacity) +
          Math.max(0, now - (stored?.at ?? now)) * rate,
      );
      const need =
        input.floor + Math.min(input.cost, input.capacity - input.floor);
      if (tokens < need)
        wait = Math.max(wait, Math.ceil((need - tokens) / rate));
      if (wait > 0) return wait;
      buckets.set(input.bucketKey, { tokens: tokens - input.cost, at: now });
      const fields = usage.get(input.usageKey) ?? {};
      fields[input.usageField] = (fields[input.usageField] ?? 0) + input.cost;
      usage.set(input.usageKey, fields);
      return 0;
    },
    async block({ key, ms, drainBucketKey }) {
      if (ttl(key) < ms) blocks.set(key, Date.now() + ms);
      if (drainBucketKey) {
        const stored = buckets.get(drainBucketKey);
        buckets.set(drainBucketKey, {
          tokens: Math.min(stored?.tokens ?? 0, 0),
          at: Date.now(),
        });
      }
    },
    async clear(key) {
      blocks.delete(key);
    },
    async note({ usageKey, field, amount }) {
      const fields = usage.get(usageKey) ?? {};
      fields[field] = (fields[field] ?? 0) + amount;
      usage.set(usageKey, fields);
    },
    async claimUsages(input) {
      return input.map(({ usageKey, claimKey }) => {
        const fields = usage.get(usageKey);
        if (!fields || claimed.has(claimKey)) return null;
        claimed.add(claimKey);
        return { ...fields };
      });
    },
    reset() {
      buckets.clear();
      blocks.clear();
      usage.clear();
      claimed.clear();
    },
  };
}
