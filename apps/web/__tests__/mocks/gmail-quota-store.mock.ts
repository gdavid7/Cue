import type { GmailQuotaStore } from "@/utils/gmail/quota-store";

/**
 * In-memory stand-in for the Redis quota store, following the same bucket
 * and window arithmetic as its Lua scripts on the (fakeable) `Date.now()`
 * clock.
 */
export function createMemoryGmailQuotaStore(): GmailQuotaStore & {
  reset(): void;
} {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const windows = new Map<string, Array<{ at: number; cost: number }>>();
  const blocks = new Map<string, number>();
  const usage = new Map<string, Record<string, number>>();
  const claimed = new Set<string>();
  const ttl = (key: string) => Math.max(0, (blocks.get(key) ?? 0) - Date.now());

  return {
    async take(input) {
      const now = Date.now();
      const held = input.blockers.filter(({ key }) => ttl(key) > 0);
      const defer = held.some(({ deferMs }) => deferMs);
      let wait = Math.max(
        0,
        ...held.map(({ key, deferMs }) => deferMs || ttl(key)),
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

      const { pace } = input;
      const recent = (windows.get(pace.key) ?? []).filter(
        (entry) => entry.at > now - pace.windowMs,
      );
      windows.set(pace.key, recent);
      const inWindow = recent.reduce((sum, entry) => sum + entry.cost, 0);
      const excess = inWindow + Math.min(input.cost, pace.cap) - pace.cap;
      if (excess > 0) {
        let freed = 0;
        for (const entry of recent) {
          freed += entry.cost;
          if (freed >= excess) {
            wait = Math.max(wait, entry.at + pace.windowMs - now + 1);
            break;
          }
        }
      }
      if (wait > 0) return { waitMs: wait, defer };

      buckets.set(input.bucketKey, { tokens: tokens - input.cost, at: now });
      recent.push({ at: now, cost: input.cost });
      const fields = usage.get(input.usageKey) ?? {};
      fields[input.usageField] = (fields[input.usageField] ?? 0) + input.cost;
      fields["peak:second"] = Math.max(
        fields["peak:second"] ?? 0,
        inWindow + input.cost,
      );
      usage.set(input.usageKey, fields);
      return { waitMs: 0, defer: false };
    },
    async block({ key, ms }) {
      if (ttl(key) < ms) blocks.set(key, Date.now() + ms);
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
      windows.clear();
      blocks.clear();
      usage.clear();
      claimed.clear();
    },
  };
}
