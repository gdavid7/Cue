import { redis } from "@/utils/redis";

/**
 * Shared, atomic state behind the Gmail quota gate. Every server instance
 * admits through the same Redis keys, so tabs, devices and background jobs
 * draw from one per-account bucket.
 */
export type GmailQuotaStore = {
  /**
   * Debits `cost` when the bucket keeps at least `floor` tokens afterwards
   * (a request larger than the bucket only needs the bucket above `floor`),
   * the units admitted in the last `pace.windowMs` stay within `pace.cap`
   * (a request larger than the cap needs an empty window) and no `blockers`
   * key exists. During a demand episode on `pace.demand.key` the cap is
   * `pace.demand.yieldCap` instead, when given (0 holds the caller until the
   * episode ends). A request with `pace.demand.markMs` starts an episode of
   * that length as it arrives, while it still waits for room as much as once
   * admitted, unless one started within `pace.demand.everyMs`, so
   * back-to-back episodes always leave the others a gap. Records the
   * busiest window in the usage hash's
   * `peak:second` field. Returns `waitMs` 0 when admitted,
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
    pace: {
      key: string;
      cap: number;
      windowMs: number;
      demand: {
        key: string;
        yieldCap?: number;
        markMs?: number;
        everyMs?: number;
      };
    };
  }): Promise<{ waitMs: number; defer: boolean }>;
  /** Sets `key` for `ms` unless it is already set for longer. */
  block(input: { key: string; ms: number }): Promise<void>;
  /**
   * Makes the demand episode on `key` last at least `ms` from now. Returns
   * when this hold ends, or 0 when a longer one was already running.
   */
  holdDemand(input: { key: string; ms: number }): Promise<number>;
  /** Ends the hold that ends at `endsAt`, unless another replaced it. */
  releaseDemand(input: { key: string; endsAt: number }): Promise<void>;
  clear(key: string): Promise<void>;
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
local paceCap = tonumber(ARGV[6])
local paceWindow = tonumber(ARGV[7])
local yieldCap = tonumber(ARGV[8])
local demandMs = tonumber(ARGV[9])
local demandEvery = tonumber(ARGV[10])
local wait = 0
local defer = 0
for i = 6, #KEYS do
  local ttl = redis.call('PTTL', KEYS[i])
  local deferMs = tonumber(ARGV[i + 5])
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
redis.call('ZREMRANGEBYSCORE', KEYS[3], '-inf', now - paceWindow)
local recent = redis.call('ZRANGE', KEYS[3], 0, -1, 'WITHSCORES')
local inWindow = 0
for j = 1, #recent, 2 do
  inWindow = inWindow + tonumber(string.match(recent[j], ':(%d+)$'))
end
-- How long until the window has room for this request under cap; -1 never.
local function windowWait(cap)
  if cap <= 0 then return -1 end
  local excess = inWindow + math.min(cost, cap) - cap
  if excess <= 0 then return 0 end
  local freed = 0
  for j = 1, #recent, 2 do
    freed = freed + tonumber(string.match(recent[j], ':(%d+)$'))
    if freed >= excess then
      return tonumber(recent[j + 1]) + paceWindow - now + 1
    end
  end
  return paceWindow
end
local paceWait = windowWait(paceCap)
local demandEnds = tonumber(redis.call('GET', KEYS[5])) or 0
local demandTtl = demandEnds - now
if yieldCap >= 0 and demandTtl > 0 then
  local afterDemand = math.max(demandTtl, paceWait)
  local yieldWait = windowWait(yieldCap)
  if yieldWait < 0 or yieldWait > afterDemand then
    paceWait = afterDemand
  else
    paceWait = yieldWait
  end
end
wait = math.max(wait, paceWait)
-- Marked on arrival, so others yield while this request waits for room.
if demandMs > 0 then
  redis.call('SET', KEYS[5], tostring(now + demandMs), 'PX', demandEvery, 'NX')
end
if wait > 0 then return {wait, defer} end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens - cost), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 300000)
local seq = redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], 300000)
redis.call('ZADD', KEYS[3], now, seq .. ':' .. cost)
redis.call('PEXPIRE', KEYS[3], paceWindow * 2)
redis.call('HINCRBY', KEYS[2], ARGV[5], cost)
local peak = tonumber(redis.call('HGET', KEYS[2], 'peak:second')) or 0
if inWindow + cost > peak then
  redis.call('HSET', KEYS[2], 'peak:second', inWindow + cost)
end
redis.call('PEXPIRE', KEYS[2], 300000)
return {0, 0}
`;

const blockScript = `
local ms = tonumber(ARGV[1])
if redis.call('PTTL', KEYS[1]) < ms then
  redis.call('SET', KEYS[1], '1', 'PX', ms)
end
return 1
`;

const holdDemandScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
local ms = tonumber(ARGV[1])
local ends = now + ms
local current = tonumber(redis.call('GET', KEYS[1])) or 0
if current >= ends then return 0 end
redis.call('SET', KEYS[1], tostring(ends), 'PX', ms)
return ends
`;

const releaseDemandScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
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
        input.pace.key,
        `${input.pace.key}:seq`,
        input.pace.demand.key,
        ...input.blockers.map((blocker) => blocker.key),
      ],
      [
        String(input.cost),
        String(input.capacity),
        String(input.perMinute),
        String(input.floor),
        input.usageField,
        String(input.pace.cap),
        String(input.pace.windowMs),
        String(input.pace.demand.yieldCap ?? -1),
        String(input.pace.demand.markMs ?? 0),
        String(input.pace.demand.everyMs ?? input.pace.demand.markMs ?? 0),
        ...input.blockers.map((blocker) => String(blocker.deferMs ?? 0)),
      ],
    );
    const waitMs = Number(result?.[0]);
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return { waitMs: 0, defer: false };
    return { waitMs, defer: Number(result?.[1]) === 1 };
  },
  async block({ key, ms }) {
    await redis.eval(blockScript, [key], [String(Math.max(1, Math.ceil(ms)))]);
  },
  async clear(key) {
    await redis.del(key);
  },
  async holdDemand({ key, ms }) {
    const endsAt = await redis.eval<string[], number>(
      holdDemandScript,
      [key],
      [String(Math.max(1, Math.ceil(ms)))],
    );
    return Number(endsAt) || 0;
  },
  async releaseDemand({ key, endsAt }) {
    await redis.eval(releaseDemandScript, [key], [String(endsAt)]);
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
