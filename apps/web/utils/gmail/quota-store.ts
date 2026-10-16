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
   * wait it out. While `pace.slowKey` exists the pace cap is halved.
   *
   * The bucket refills at the per-minute budget kept in `budget.key`:
   * `budget.start` until one is set, raised by `budget.raiseFactor` for each
   * `budget.raiseEveryMs` since it last changed, up to `budget.max`. Each
   * admission is also counted in `budget.trailingKey` for `cutBudget`, and
   * the budget it ran at is kept in the usage hash's `budget:perMinute`.
   */
  take(input: {
    bucketKey: string;
    usageKey: string;
    usageField: string;
    blockers: { key: string; deferMs?: number }[];
    cost: number;
    capacity: number;
    budget: {
      key: string;
      trailingKey: string;
      trailingWindowMs: number;
      start: number;
      max: number;
      raiseFactor: number;
      raiseEveryMs: number;
    };
    floor: number;
    /**
     * How long the caller will still wait. A wait past it on anything but
     * the pace means the caller gives up, so it starts no demand episode.
     */
    waitBudgetMs?: number;
    pace: {
      key: string;
      cap: number;
      windowMs: number;
      slowKey?: string;
      demand: {
        key: string;
        yieldCap?: number;
        markMs?: number;
        everyMs?: number;
      };
    };
  }): Promise<{ waitMs: number; defer: boolean }>;
  /**
   * Lowers the budget in `key` to `fraction` of the units admitted within
   * `trailingWindowMs` (counted in `trailingKey`), never below `floor`, and
   * restarts its quiet period. Returns the budget.
   */
  cutBudget(input: {
    key: string;
    trailingKey: string;
    trailingWindowMs: number;
    start: number;
    fraction: number;
    floor: number;
  }): Promise<number>;
  /** Sets `key` for `ms` unless it is already set for longer. */
  block(input: { key: string; ms: number }): Promise<void>;
  /**
   * Makes the demand episode on `key` last at least `ms` from now, then
   * starts no other for `gapMs`, as between two requests' episodes. Returns
   * when this hold ends, or 0 when a longer one was already running.
   */
  holdDemand(input: {
    key: string;
    ms: number;
    gapMs: number;
  }): Promise<number>;
  /**
   * Ends the hold that ends at `endsAt`, unless another replaced it, leaving
   * the `gapMs` before another episode may start.
   */
  releaseDemand(input: {
    key: string;
    endsAt: number;
    gapMs: number;
  }): Promise<void>;
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
local floor = tonumber(ARGV[4])
local paceCap = tonumber(ARGV[6])
local paceWindow = tonumber(ARGV[7])
local yieldCap = tonumber(ARGV[8])
local demandMs = tonumber(ARGV[9])
local demandEvery = tonumber(ARGV[10])
local waitBudget = tonumber(ARGV[11])
if ARGV[12] == '1' and redis.call('EXISTS', KEYS[6]) == 1 then
  paceCap = math.floor(paceCap / 2)
end
local trailingWindow = tonumber(ARGV[3])
local budgetStart = tonumber(ARGV[13])
local budgetMax = tonumber(ARGV[14])
local raiseFactor = tonumber(ARGV[15])
local raiseEvery = tonumber(ARGV[16])
local budget = redis.call('HMGET', KEYS[7], 'perMinute', 'at')
local perMinute = tonumber(budget[1])
local budgetAt = tonumber(budget[2]) or now
if not perMinute then
  perMinute = budgetStart
  budgetAt = now
  redis.call('HSET', KEYS[7], 'perMinute', tostring(perMinute), 'at', tostring(now))
elseif now - budgetAt >= raiseEvery then
  local steps = math.floor((now - budgetAt) / raiseEvery)
  perMinute = math.min(budgetMax, math.floor(perMinute * raiseFactor ^ steps))
  budgetAt = budgetAt + steps * raiseEvery
  redis.call('HSET', KEYS[7], 'perMinute', tostring(perMinute), 'at', tostring(budgetAt))
end
redis.call('PEXPIRE', KEYS[7], 86400000)
local rate = perMinute / 60000
local wait = 0
local defer = 0
for i = 9, #KEYS do
  local ttl = redis.call('PTTL', KEYS[i])
  local deferMs = tonumber(ARGV[i + 8])
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
-- The pace is what others yielding frees; nothing frees the rest sooner.
local unpacedWait = wait
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
-- Marked on arrival, so others yield while this request waits for room,
-- unless it will give up before anything but the pace lets it in.
if demandMs > 0 and (waitBudget < 0 or unpacedWait <= waitBudget) then
  redis.call('SET', KEYS[5], tostring(now + demandMs), 'PX', demandEvery, 'NX')
end
if wait > 0 then return {wait, defer} end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens - cost), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 300000)
local seq = redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], 300000)
redis.call('ZADD', KEYS[3], now, seq .. ':' .. cost)
redis.call('PEXPIRE', KEYS[3], paceWindow * 2)
redis.call('ZADD', KEYS[8], now, seq .. ':' .. cost)
redis.call('ZREMRANGEBYSCORE', KEYS[8], '-inf', now - trailingWindow)
redis.call('PEXPIRE', KEYS[8], trailingWindow * 2)
redis.call('HINCRBY', KEYS[2], ARGV[5], cost)
redis.call('HSET', KEYS[2], 'budget:perMinute', math.floor(perMinute))
local peak = tonumber(redis.call('HGET', KEYS[2], 'peak:second')) or 0
if inWindow + cost > peak then
  redis.call('HSET', KEYS[2], 'peak:second', inWindow + cost)
end
redis.call('PEXPIRE', KEYS[2], 300000)
return {0, 0}
`;

const cutBudgetScript = `
local time = redis.call('TIME')
local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - tonumber(ARGV[1]))
local recent = redis.call('ZRANGE', KEYS[2], 0, -1)
local units = 0
for j = 1, #recent do
  units = units + tonumber(string.match(recent[j], ':(%d+)$'))
end
local current = tonumber(redis.call('HGET', KEYS[1], 'perMinute')) or tonumber(ARGV[2])
local cut = math.max(tonumber(ARGV[4]), math.floor(units * tonumber(ARGV[3])))
local budget = math.min(current, cut)
redis.call('HSET', KEYS[1], 'perMinute', tostring(budget), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 86400000)
return budget
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
local gap = tonumber(ARGV[2])
local ends = now + ms
local current = tonumber(redis.call('GET', KEYS[1])) or 0
if current >= ends then return 0 end
redis.call('SET', KEYS[1], tostring(ends), 'PX', ms + gap)
return ends
`;

// Ended rather than deleted, so the next episode still waits out the gap.
const releaseDemandScript = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  local time = redis.call('TIME')
  local now = tonumber(time[1]) * 1000 + math.floor(tonumber(time[2]) / 1000)
  redis.call('SET', KEYS[1], tostring(now), 'PX', tonumber(ARGV[2]))
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
        input.pace.slowKey ?? input.pace.key,
        input.budget.key,
        input.budget.trailingKey,
        ...input.blockers.map((blocker) => blocker.key),
      ],
      [
        String(input.cost),
        String(input.capacity),
        String(input.budget.trailingWindowMs),
        String(input.floor),
        input.usageField,
        String(input.pace.cap),
        String(input.pace.windowMs),
        String(input.pace.demand.yieldCap ?? -1),
        String(input.pace.demand.markMs ?? 0),
        String(input.pace.demand.everyMs ?? input.pace.demand.markMs ?? 0),
        String(input.waitBudgetMs ?? -1),
        input.pace.slowKey ? "1" : "0",
        String(input.budget.start),
        String(input.budget.max),
        String(input.budget.raiseFactor),
        String(input.budget.raiseEveryMs),
        ...input.blockers.map((blocker) => String(blocker.deferMs ?? 0)),
      ],
    );
    const waitMs = Number(result?.[0]);
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return { waitMs: 0, defer: false };
    return { waitMs, defer: Number(result?.[1]) === 1 };
  },
  async cutBudget(input) {
    const budget = await redis.eval<string[], number>(
      cutBudgetScript,
      [input.key, input.trailingKey],
      [
        String(input.trailingWindowMs),
        String(input.start),
        String(input.fraction),
        String(input.floor),
      ],
    );
    return Number(budget);
  },
  async block({ key, ms }) {
    await redis.eval(blockScript, [key], [String(Math.max(1, Math.ceil(ms)))]);
  },
  async clear(key) {
    await redis.del(key);
  },
  async holdDemand({ key, ms, gapMs }) {
    const endsAt = await redis.eval<string[], number>(
      holdDemandScript,
      [key],
      [String(Math.max(1, Math.ceil(ms))), String(Math.max(1, gapMs))],
    );
    return Number(endsAt) || 0;
  },
  async releaseDemand({ key, endsAt, gapMs }) {
    await redis.eval(
      releaseDemandScript,
      [key],
      [String(endsAt), String(Math.max(1, gapMs))],
    );
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
