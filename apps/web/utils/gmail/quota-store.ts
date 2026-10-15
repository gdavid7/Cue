import { redis } from "@/utils/redis";

/**
 * Shared, atomic state behind the Gmail quota gate. Every server instance
 * admits through the same Redis keys, so tabs, devices and background jobs
 * draw from one per-account bucket.
 */
export type GmailQuotaStore = {
  /**
   * Debits `cost` when the bucket keeps at least `floor` tokens afterwards
   * (a request larger than the bucket only needs the bucket above `floor`)
   * and no `blockers` key exists. Returns `waitMs` 0 when admitted,
   * otherwise the milliseconds to wait before asking again. A blocker with
   * `deferMs` is lifted explicitly, usually long before it expires, so a
   * caller it holds is told to come back in `deferMs` (`defer`) rather than
   * wait it out.
   */
  take(input: {
    bucketKey: string;
    usageKey: string;
    usageField: string;
    blockers: { key: string; deferMs?: number }[];
    cost: number;
    capacity: number;
    perMinute: number;
    floor: number;
  }): Promise<{ waitMs: number; defer: boolean }>;
  /** Sets `key` for `ms` unless it is already set for longer; optionally empties the bucket. */
  block(input: {
    key: string;
    ms: number;
    drainBucketKey?: string;
  }): Promise<void>;
  clear(key: string): Promise<void>;
  isSet(key: string): Promise<boolean>;
  /** Adds `amount` to a usage field without admitting anything. */
  note(input: {
    usageKey: string;
    field: string;
    amount: number;
  }): Promise<void>;
  /**
   * Returns each usage hash once: the first caller claims it. A hash already
   * claimed, or with no usage, comes back as null.
   */
  claimUsages(
    input: { usageKey: string; claimKey: string }[],
  ): Promise<(Record<string, number> | null)[]>;
};

const takeScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local cost = tonumber(ARGV[1])
local capacity = tonumber(ARGV[2])
local rate = tonumber(ARGV[3]) / 60000
local floor = tonumber(ARGV[4])
local wait = 0
local defer = 0
for i = 3, #KEYS do
  local ttl = redis.call('PTTL', KEYS[i])
  local deferMs = tonumber(ARGV[i + 3])
  if ttl > 0 and deferMs and deferMs > 0 then
    ttl = deferMs
    defer = 1
  end
  if ttl > wait then wait = ttl end
end
local stored = redis.call('HMGET', KEYS[1], 'tokens', 'at')
local tokens = tonumber(stored[1]) or capacity
local at = tonumber(stored[2]) or now
tokens = math.min(capacity, tokens + math.max(0, now - at) * rate)
local need = floor + math.min(cost, capacity - floor)
if tokens < need then
  wait = math.max(wait, math.ceil((need - tokens) / rate))
end
if wait > 0 then return {wait, defer} end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens - cost), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 300000)
redis.call('HINCRBY', KEYS[2], ARGV[5], cost)
redis.call('PEXPIRE', KEYS[2], 300000)
return {0, 0}
`;

const blockScript = `
local ms = tonumber(ARGV[1])
if redis.call('PTTL', KEYS[1]) < ms then
  redis.call('SET', KEYS[1], '1', 'PX', ms)
end
if KEYS[2] then
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  local tokens = tonumber(redis.call('HGET', KEYS[2], 'tokens'))
  if tokens == nil or tokens > 0 then tokens = 0 end
  redis.call('HSET', KEYS[2], 'tokens', tostring(tokens), 'at', tostring(now))
  redis.call('PEXPIRE', KEYS[2], 300000)
end
return 1
`;

const noteScript = `
redis.call('HINCRBY', KEYS[1], ARGV[1], tonumber(ARGV[2]))
redis.call('PEXPIRE', KEYS[1], 300000)
return 1
`;

const claimScript = `
local claimed = {}
for i = 1, #KEYS, 2 do
  if redis.call('EXISTS', KEYS[i]) == 1 and redis.call('SET', KEYS[i + 1], '1', 'NX', 'PX', 300000) then
    claimed[#claimed + 1] = redis.call('HGETALL', KEYS[i])
  else
    claimed[#claimed + 1] = {}
  end
end
return claimed
`;

export const gmailQuotaStore: GmailQuotaStore = {
  async take(input) {
    const result = await redis.eval<string[], [number, number] | null>(
      takeScript,
      [
        input.bucketKey,
        input.usageKey,
        ...input.blockers.map((blocker) => blocker.key),
      ],
      [
        String(input.cost),
        String(input.capacity),
        String(input.perMinute),
        String(input.floor),
        input.usageField,
        ...input.blockers.map((blocker) => String(blocker.deferMs ?? 0)),
      ],
    );
    const waitMs = Number(result?.[0]);
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return { waitMs: 0, defer: false };
    return { waitMs, defer: Number(result?.[1]) === 1 };
  },
  async block({ key, ms, drainBucketKey }) {
    await redis.eval(
      blockScript,
      drainBucketKey ? [key, drainBucketKey] : [key],
      [String(Math.max(1, Math.ceil(ms)))],
    );
  },
  async clear(key) {
    await redis.del(key);
  },
  async isSet(key) {
    return (await redis.exists(key)) > 0;
  },
  async note({ usageKey, field, amount }) {
    await redis.eval(noteScript, [usageKey], [field, String(amount)]);
  },
  async claimUsages(input) {
    const claimed = await redis.eval<string[], (string | number)[][] | null>(
      claimScript,
      input.flatMap(({ usageKey, claimKey }) => [usageKey, claimKey]),
      [],
    );
    return input.map((_, index) => {
      const flat = Array.isArray(claimed) ? claimed[index] : null;
      if (!Array.isArray(flat) || flat.length === 0) return null;
      const usage: Record<string, number> = {};
      for (let i = 0; i + 1 < flat.length; i += 2) {
        usage[String(flat[i])] = Number(flat[i + 1]) || 0;
      }
      return usage;
    });
  },
};
