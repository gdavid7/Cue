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
   *
   * Once `cost` is admitted, the same round trip also admits, in order, the
   * `queued` requests waiting behind it on this instance while each still
   * fits the same rules (`queued` in the result says how many), and then
   * reserves up to `ahead.units` (whole multiples of `ahead.step`) for calls
   * this instance expects within `ahead.leaseMs`. Units reserved ahead come
   * only from the part of the second's pace and of the bucket above
   * `ahead.share` of each, and stay in the pace window until the lease ends,
   * so a second never carries more than its cap however late they are spent.
   * `notes` are added to the usage hash whether or not anything is admitted.
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
    queued?: number[];
    ahead?: { units: number; step: number; leaseMs: number; share: number };
    notes?: { field: string; amount: number }[];
  }): Promise<{
    waitMs: number;
    defer: boolean;
    queued: number;
    ahead: number;
  }>;
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
  /** Adds each amount to its usage field without admitting anything. */
  note(notes: GmailQuotaNote[]): Promise<void>;
  /**
   * Adds `notes` first, then returns each usage hash once: the first caller
   * claims it. A hash already claimed, or with no usage, comes back as null.
   */
  claimUsages(
    input: { usageKey: string; claimKey: string }[],
    notes?: GmailQuotaNote[],
  ): Promise<(Record<string, number> | null)[]>;
};

export type GmailQuotaNote = {
  usageKey: string;
  field: string;
  amount: number;
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
local queuedCount = tonumber(ARGV[17])
local aheadUnits = tonumber(ARGV[18])
local aheadStep = tonumber(ARGV[19])
local aheadLease = tonumber(ARGV[20])
local aheadShare = tonumber(ARGV[21])
local noteCount = tonumber(ARGV[22])
local blockerCount = #KEYS - 8
local queuedAt = 23 + blockerCount
local notesAt = queuedAt + queuedCount
for n = 0, noteCount - 1 do
  redis.call('HINCRBY', KEYS[2], ARGV[notesAt + 2 * n], tonumber(ARGV[notesAt + 2 * n + 1]))
end
if noteCount > 0 then redis.call('PEXPIRE', KEYS[2], 300000) end
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
  local deferMs = tonumber(ARGV[i + 14])
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
if wait > 0 then return {wait, defer, 0, 0} end
-- What this second may still carry, at the cap this caller's priority has now.
local grantCap = paceCap
if yieldCap >= 0 and demandTtl > 0 then grantCap = math.min(paceCap, yieldCap) end
local used = cost
local admittedQueued = 0
for q = 0, queuedCount - 1 do
  local queuedCost = tonumber(ARGV[queuedAt + q])
  if tokens - used - queuedCost < floor or inWindow + used + queuedCost > grantCap then break end
  used = used + queuedCost
  admittedQueued = admittedQueued + 1
end
local ahead = 0
if aheadUnits > 0 and aheadStep > 0 then
  local room = math.min(
    grantCap * aheadShare - inWindow - used,
    tokens - used - math.max(floor, capacity / 2),
    aheadUnits)
  if room > 0 then ahead = math.floor(room / aheadStep) * aheadStep end
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens - used - ahead), 'at', tostring(now))
redis.call('PEXPIRE', KEYS[1], 300000)
local seq = redis.call('INCR', KEYS[4])
redis.call('PEXPIRE', KEYS[4], 300000)
redis.call('ZADD', KEYS[3], now, seq .. ':' .. used)
if ahead > 0 then
  -- Scored at the lease's end: it holds its place in the window until then.
  redis.call('ZADD', KEYS[3], now + aheadLease, seq .. ':ahead:' .. ahead)
end
redis.call('PEXPIRE', KEYS[3], paceWindow * 2 + aheadLease)
redis.call('ZADD', KEYS[8], now, seq .. ':' .. (used + ahead))
redis.call('ZREMRANGEBYSCORE', KEYS[8], '-inf', now - trailingWindow)
redis.call('PEXPIRE', KEYS[8], trailingWindow * 2)
redis.call('HINCRBY', KEYS[2], ARGV[5], cost)
redis.call('HSET', KEYS[2], 'budget:perMinute', math.floor(perMinute))
local peak = tonumber(redis.call('HGET', KEYS[2], 'peak:second')) or 0
if inWindow + used > peak then
  redis.call('HSET', KEYS[2], 'peak:second', inWindow + used)
end
redis.call('PEXPIRE', KEYS[2], 300000)
return {0, 0, admittedQueued, ahead}
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

// KEYS: the claimed pairs (ARGV[1] of them), then each note's usage key.
// ARGV after the pair count: each note's field and amount.
const applyNotes = `
local claimPairs = tonumber(ARGV[1])
for n = 2 * claimPairs + 1, #KEYS do
  local at = 2 + 2 * (n - 2 * claimPairs - 1)
  redis.call('HINCRBY', KEYS[n], ARGV[at], tonumber(ARGV[at + 1]))
  redis.call('PEXPIRE', KEYS[n], 300000)
end
`;

const noteScript = `${applyNotes}
return 1
`;

const claimScript = `${applyNotes}
local claimed = {}
for i = 1, 2 * claimPairs, 2 do
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
    const queued = input.queued ?? [];
    const notes = input.notes ?? [];
    const result = await redis.eval<string[], number[] | null>(
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
        String(queued.length),
        String(input.ahead?.units ?? 0),
        String(input.ahead?.step ?? 0),
        String(input.ahead?.leaseMs ?? 0),
        String(input.ahead?.share ?? 0),
        String(notes.length),
        ...input.blockers.map((blocker) => String(blocker.deferMs ?? 0)),
        ...queued.map(String),
        ...notes.flatMap((note) => [note.field, String(note.amount)]),
      ],
    );
    const waitMs = Number(result?.[0]);
    if (!Number.isFinite(waitMs) || waitMs <= 0)
      return {
        waitMs: 0,
        defer: false,
        queued: Number(result?.[2]) || 0,
        ahead: Number(result?.[3]) || 0,
      };
    return { waitMs, defer: Number(result?.[1]) === 1, queued: 0, ahead: 0 };
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
  async note(notes) {
    if (notes.length === 0) return;
    await redis.eval(
      noteScript,
      notes.map((note) => note.usageKey),
      noteArgs(0, notes),
    );
  },
  async claimUsages(input, notes = []) {
    const claimed = await redis.eval<string[], (string | number)[][] | null>(
      claimScript,
      [
        ...input.flatMap(({ usageKey, claimKey }) => [usageKey, claimKey]),
        ...notes.map((note) => note.usageKey),
      ],
      noteArgs(input.length, notes),
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

function noteArgs(pairs: number, notes: GmailQuotaNote[]) {
  return [
    String(pairs),
    ...notes.flatMap((note) => [note.field, String(note.amount)]),
  ];
}
