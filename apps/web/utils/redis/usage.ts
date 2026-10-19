import "server-only";
import type { LanguageModelUsage } from "ai";
import { redis } from "@/utils/redis";
import { createScopedLogger } from "@/utils/logger";
import { logRedisFailureOnce } from "@/utils/redis/unavailable-log";
import type { AiSpendBucket } from "@/utils/llms/spend-bucket";

const logger = createScopedLogger("redis/usage");
const WEEKLY_USAGE_COST_DAYS = 7;
const WEEKLY_USAGE_COST_TTL_SECONDS = 8 * 24 * 60 * 60;
const WEEKLY_USAGE_COST_KEY_PREFIX = "usage-weekly-cost";
const USAGE_MIGRATION_LOCK_TTL_SECONDS = 5 * 60;

// KEYS: the usage hashes, then the weekly cost hash when ARGV[1] isn't '0'.
// ARGV: that flag ('2' also adds the cost to the weekly triage cost), the
// cost, the weekly TTL, then field/increment pairs.
const saveUsageScript = `
local weekly = ARGV[1] ~= '0'
local cost = tonumber(ARGV[2])
local hashes = #KEYS
if weekly then hashes = hashes - 1 end
for i = 1, hashes do
  for j = 4, #ARGV, 2 do
    redis.call('HINCRBY', KEYS[i], ARGV[j], ARGV[j + 1])
  end
  if cost > 0 then redis.call('HINCRBYFLOAT', KEYS[i], 'cost', ARGV[2]) end
end
if weekly then
  redis.call('HINCRBYFLOAT', KEYS[#KEYS], 'cost', ARGV[2])
  if ARGV[1] == '2' then
    redis.call('HINCRBYFLOAT', KEYS[#KEYS], 'triageCost', ARGV[2])
  end
  redis.call('EXPIRE', KEYS[#KEYS], tonumber(ARGV[3]))
end
return 1
`;

// Returns each key's cost then its triage cost, flattened.
const readCostsScript = `
local costs = {}
for i = 1, #KEYS do
  local values = redis.call('HMGET', KEYS[i], 'cost', 'triageCost')
  costs[2 * i - 1] = values[1] or ''
  costs[2 * i] = values[2] or ''
end
return costs
`;

export type RedisUsage = {
  calls?: number;
  tokensUsed?: number;
  completionTokensUsed?: number;
  promptTokensUsed?: number;
  cachedInputTokensUsed?: number;
  reasoningTokensUsed?: number;
  cost?: number;
};

const usageFields = [
  "calls",
  "tokensUsed",
  "completionTokensUsed",
  "promptTokensUsed",
  "cachedInputTokensUsed",
  "reasoningTokensUsed",
  "cost",
] as const satisfies Array<keyof RedisUsage>;

// Fields were previously named openai* when OpenAI was the only LLM provider.
// They've always aggregated usage across all providers, so we renamed them.
const LEGACY_USAGE_FIELD_NAMES: Record<string, keyof RedisUsage> = {
  openaiCalls: "calls",
  openaiTokensUsed: "tokensUsed",
  openaiCompletionTokensUsed: "completionTokensUsed",
  openaiPromptTokensUsed: "promptTokensUsed",
};

const LEGACY_USAGE_FIELD_NAMES_BY_CURRENT = Object.fromEntries(
  Object.entries(LEGACY_USAGE_FIELD_NAMES).map(
    ([legacyField, currentField]) => [currentField, legacyField],
  ),
) as Partial<Record<keyof RedisUsage, string>>;

export type WeeklyUsageCostBySubject =
  | { userId: string; cost: number }
  | { email: string; cost: number };

type UsageKeyIdentity =
  | { type: "email-account"; id: string }
  | { type: "user"; id: string };

function getUsageKey(identity: UsageKeyIdentity) {
  return `usage:${identity.type}:${identity.id}`;
}

export async function getUsage(options: {
  emailAccountId: string;
  legacyEmail?: string | null;
  userId?: string | null;
}) {
  const emailAccountUsageKey = getUsageKey({
    type: "email-account",
    id: options.emailAccountId,
  });
  const userUsageKey = options.userId
    ? getUsageKey({ type: "user", id: options.userId })
    : null;

  if (!options.legacyEmail) {
    return getRedisUsage(emailAccountUsageKey);
  }

  const legacyUsageKey = getLegacyUsageKey(options.legacyEmail);
  const migrationName = `usage-email-account:${options.emailAccountId}`;
  const doneKey = getUsageMigrationDoneKey(migrationName);
  const lockKey = getUsageMigrationLockKey(migrationName);
  const rawMigrationState = await redis.get(doneKey);
  const migratedLegacyUsage = parseLegacyUsageMigrationState(rawMigrationState);

  if (migratedLegacyUsage) {
    const [currentUsage, legacyUsage] = await Promise.all([
      getRedisUsage(emailAccountUsageKey),
      getRedisUsage(legacyUsageKey),
    ]);
    const legacyDelta = getUsageDelta(legacyUsage, migratedLegacyUsage);

    if (hasUsageData(legacyDelta)) {
      const claimedLock = await redis.set(lockKey, new Date().toISOString(), {
        nx: true,
        ex: USAGE_MIGRATION_LOCK_TTL_SECONDS,
      });

      if (!claimedLock) return mergeUsage(currentUsage, legacyDelta);

      try {
        const [latestCurrentUsage, latestLegacyUsage, latestRawMigrationState] =
          await Promise.all([
            getRedisUsage(emailAccountUsageKey),
            getRedisUsage(legacyUsageKey),
            redis.get(doneKey),
          ]);
        const latestMigratedLegacyUsage = parseLegacyUsageMigrationState(
          latestRawMigrationState,
        );

        if (!latestMigratedLegacyUsage) {
          return maxUsage(latestCurrentUsage, latestLegacyUsage);
        }

        const latestLegacyDelta = getUsageDelta(
          latestLegacyUsage,
          latestMigratedLegacyUsage,
        );

        if (hasUsageData(latestLegacyDelta)) {
          await Promise.all([
            ...getUsageDataIncrementOperations(
              emailAccountUsageKey,
              latestLegacyDelta,
            ),
            ...(userUsageKey
              ? getUsageDataIncrementOperations(userUsageKey, latestLegacyDelta)
              : []),
            redis.set(
              doneKey,
              serializeLegacyUsageMigrationState(latestLegacyUsage),
            ),
          ]);
        }

        return mergeUsage(latestCurrentUsage, latestLegacyDelta);
      } catch (error) {
        logger.error("Failed to migrate legacy usage delta", {
          migrationName,
          error,
        });
      } finally {
        try {
          await redis.del(lockKey);
        } catch (error) {
          logger.error("Failed to clear usage migration lock", {
            migrationName,
            error,
          });
        }
      }
    }

    return mergeUsage(currentUsage, legacyDelta);
  }

  if (rawMigrationState) {
    const [currentUsage, legacyUsage] = await Promise.all([
      getRedisUsage(emailAccountUsageKey),
      getRedisUsage(legacyUsageKey),
    ]);
    return maxUsage(currentUsage, legacyUsage);
  }

  const claimedLock = await redis.set(lockKey, new Date().toISOString(), {
    nx: true,
    ex: USAGE_MIGRATION_LOCK_TTL_SECONDS,
  });
  const [currentUsage, legacyUsage] = await Promise.all([
    getRedisUsage(emailAccountUsageKey),
    getRedisUsage(legacyUsageKey),
  ]);

  if (!claimedLock) return mergeUsage(currentUsage, legacyUsage);

  try {
    await Promise.all([
      ...getUsageDataIncrementOperations(emailAccountUsageKey, legacyUsage),
      ...(userUsageKey
        ? getUsageDataIncrementOperations(userUsageKey, legacyUsage)
        : []),
      redis.set(doneKey, serializeLegacyUsageMigrationState(legacyUsage)),
    ]);

    return getRedisUsage(emailAccountUsageKey);
  } catch (error) {
    logger.error("Failed to migrate legacy usage", {
      migrationName,
      error,
    });
    return mergeUsage(currentUsage, legacyUsage);
  } finally {
    try {
      await redis.del(lockKey);
    } catch (error) {
      logger.error("Failed to clear usage migration lock", {
        migrationName,
        error,
      });
    }
  }
}

export async function saveUsage(options: {
  userId?: string | null;
  emailAccountId: string;
  usage: LanguageModelUsage;
  cost: number;
  spendBucket: AiSpendBucket;
  now?: Date;
}) {
  const {
    userId,
    emailAccountId,
    usage,
    cost,
    spendBucket,
    now = new Date(),
  } = options;

  const usageKeys = [
    getUsageKey({ type: "email-account", id: emailAccountId }),
    ...(userId ? [getUsageKey({ type: "user", id: userId })] : []),
  ];
  const weeklyCostKey =
    userId && cost ? getWeeklyUsageCostKey(userId, now) : null;

  // One command for every hash: each Redis command is billed, and this runs
  // on every AI call.
  const fields = getUsageIncrementFields(usage);
  try {
    await redis.eval(
      saveUsageScript,
      weeklyCostKey ? [...usageKeys, weeklyCostKey] : usageKeys,
      [
        getWeeklyCostFlag(weeklyCostKey, spendBucket),
        String(cost || 0),
        String(WEEKLY_USAGE_COST_TTL_SECONDS),
        ...fields.flatMap(([field, value]) => [field, String(value)]),
      ],
    );
  } catch (error) {
    // `raw` is the provider's own usage payload, keyed differently per provider.
    const { raw: _raw, ...loggedUsage } = usage;
    logRedisFailureOnce(logger, "Error saving AI usage", {
      error,
      cost,
      usage: loggedUsage,
    });
  }
}

// Spend recorded before triage had its own bucket, and legacy per-email
// spend, counts as interactive.
export async function getWeeklyUsageCostByBucket({
  userId,
  legacyEmails = [],
  now = new Date(),
}: {
  userId: string;
  legacyEmails?: string[];
  now?: Date;
}): Promise<{ total: number } & Record<AiSpendBucket, number>> {
  const usageKeys = getWeeklyUsageCostKeys(userId, now);
  const current = await readWeeklyCostTotals(usageKeys);
  const total = await addLegacyWeeklyUsageCost({
    userId,
    legacyEmails,
    now,
    usageKeys,
    migratedCost: current.cost,
  });
  const triage = Math.min(current.triageCost, total);

  return { total, triage, interactive: total - triage };
}

async function addLegacyWeeklyUsageCost({
  userId,
  legacyEmails,
  now,
  usageKeys,
  migratedCost,
}: {
  userId: string;
  legacyEmails: string[];
  now: Date;
  usageKeys: string[];
  migratedCost: number;
}) {
  const uniqueLegacyEmails = Array.from(new Set(legacyEmails));
  if (!uniqueLegacyEmails.length) return migratedCost;

  const legacyCostsByKey = await getLegacyWeeklyUsageCostsByDay({
    emails: uniqueLegacyEmails,
    now,
  });

  const migrationName = `weekly-usage-cost-user:${userId}`;
  const doneKey = getUsageMigrationDoneKey(migrationName);
  const lockKey = getUsageMigrationLockKey(migrationName);
  const rawMigrationState = await redis.get(doneKey);
  const migratedLegacyCosts = parseWeeklyUsageMigrationState(rawMigrationState);

  if (migratedLegacyCosts) {
    const legacyDeltaByKey = getLegacyWeeklyCostDelta(
      legacyCostsByKey,
      migratedLegacyCosts,
    );
    const legacyDelta = sumMapValues(legacyDeltaByKey);

    if (legacyDelta > 0) {
      const claimedLock = await redis.set(lockKey, new Date().toISOString(), {
        nx: true,
        ex: USAGE_MIGRATION_LOCK_TTL_SECONDS,
      });

      if (!claimedLock) return migratedCost + legacyDelta;

      try {
        const [
          latestLegacyCostsByKey,
          latestMigratedCost,
          latestRawMigrationState,
        ] = await Promise.all([
          getLegacyWeeklyUsageCostsByDay({
            emails: uniqueLegacyEmails,
            now,
          }),
          getWeeklyUsageCostTotal(usageKeys),
          redis.get(doneKey),
        ]);
        const latestMigratedLegacyCosts = parseWeeklyUsageMigrationState(
          latestRawMigrationState,
        );

        if (!latestMigratedLegacyCosts) {
          return Math.max(
            latestMigratedCost,
            sumMapValues(latestLegacyCostsByKey),
          );
        }

        const latestLegacyDeltaByKey = getLegacyWeeklyCostDelta(
          latestLegacyCostsByKey,
          latestMigratedLegacyCosts,
        );
        const latestLegacyDelta = sumMapValues(latestLegacyDeltaByKey);

        if (latestLegacyDelta > 0) {
          await Promise.all([
            ...getWeeklyCostIncrementOperations(userId, latestLegacyDeltaByKey),
            redis.set(
              doneKey,
              serializeWeeklyUsageMigrationState(latestLegacyCostsByKey),
            ),
          ]);
        }

        return latestMigratedCost + latestLegacyDelta;
      } catch (error) {
        logger.error("Failed to migrate legacy weekly usage delta", {
          migrationName,
          error,
        });
      } finally {
        try {
          await redis.del(lockKey);
        } catch (error) {
          logger.error("Failed to clear weekly usage migration lock", {
            migrationName,
            error,
          });
        }
      }
    }

    return migratedCost + legacyDelta;
  }

  if (rawMigrationState) {
    return Math.max(migratedCost, sumMapValues(legacyCostsByKey));
  }

  const claimedLock = await redis.set(lockKey, new Date().toISOString(), {
    nx: true,
    ex: USAGE_MIGRATION_LOCK_TTL_SECONDS,
  });

  if (!claimedLock) return migratedCost + sumMapValues(legacyCostsByKey);

  try {
    await Promise.all([
      ...getWeeklyCostIncrementOperations(userId, legacyCostsByKey),
      redis.set(doneKey, serializeWeeklyUsageMigrationState(legacyCostsByKey)),
    ]);
  } catch (error) {
    logger.error("Failed to migrate legacy weekly usage", {
      migrationName,
      error,
    });
    return migratedCost + sumMapValues(legacyCostsByKey);
  } finally {
    try {
      await redis.del(lockKey);
    } catch (error) {
      logger.error("Failed to clear weekly usage migration lock", {
        migrationName,
        error,
      });
    }
  }

  const updatedWeeklyCost = await getWeeklyUsageCostTotal(usageKeys);

  return Math.max(updatedWeeklyCost, sumMapValues(legacyCostsByKey));
}

export async function getTopWeeklyUsageCosts({
  limit = 20,
  now = new Date(),
}: {
  limit?: number;
  now?: Date;
} = {}): Promise<WeeklyUsageCostBySubject[]> {
  if (limit <= 0) return [];

  const daysInWindow = new Set(getWeeklyUsageCostDays(now));
  const costsBySubject = new Map<string, number>();
  let cursor = "0";

  do {
    const [nextCursor, batch] = await redis.scan(cursor, {
      match: `${WEEKLY_USAGE_COST_KEY_PREFIX}:*`,
      count: 200,
    });
    cursor = String(nextCursor);

    const costEntries = await Promise.all(
      batch.map(async (key) => {
        const parsed = parseWeeklyUsageCostKey(key);
        if (!parsed || !daysInWindow.has(parsed.day)) return null;

        const data = await redis.hgetall<{ cost?: string | number }>(key);
        const cost = parseRedisNumber(data?.cost);
        if (cost <= 0) return null;

        return { ...parsed, cost };
      }),
    );

    for (const entry of costEntries) {
      if (!entry) continue;
      costsBySubject.set(
        entry.subject,
        (costsBySubject.get(entry.subject) ?? 0) + entry.cost,
      );
    }
  } while (cursor !== "0");

  return Array.from(costsBySubject.entries())
    .map(([subject, cost]) => {
      if (subject.startsWith("user:")) {
        return { userId: subject.slice("user:".length), cost };
      }
      return { email: subject.slice("email:".length), cost };
    })
    .sort((a, b) => b.cost - a.cost)
    .slice(0, limit);
}

export function getWeeklyUsageCostWindow(now: Date) {
  const days = getWeeklyUsageCostDays(now);
  const latestDay = days[0];
  const earliestDay = days.at(-1);

  if (!latestDay || !earliestDay) {
    return { startTimestampMs: 0, endTimestampMs: 0 };
  }

  const end = new Date(`${latestDay}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);

  return {
    startTimestampMs: new Date(`${earliestDay}T00:00:00.000Z`).getTime(),
    endTimestampMs: end.getTime(),
  };
}

function getUsageIncrementFields(
  usage: LanguageModelUsage,
): [keyof RedisUsage, number][] {
  const fields: [keyof RedisUsage, number | undefined][] = [
    ["calls", 1],
    ["tokensUsed", usage.totalTokens],
    ["completionTokensUsed", usage.outputTokens],
    ["promptTokensUsed", usage.inputTokens],
    ["cachedInputTokensUsed", usage.inputTokenDetails?.cacheReadTokens],
    ["reasoningTokensUsed", usage.outputTokenDetails?.reasoningTokens],
  ];
  // HINCRBY takes whole numbers only, and a rejected increment aborts the
  // script's other writes too.
  return fields.flatMap(([field, value]) => {
    const whole = Math.round(value ?? 0);
    return whole > 0 ? [[field, whole] as [keyof RedisUsage, number]] : [];
  });
}

function getUsageDataIncrementOperations(
  key: string,
  usage: RedisUsage | null,
) {
  if (!usage) return [];

  return usageFields.flatMap((field) => {
    const value = parseRedisNumber(usage[field]);
    if (value <= 0) return [];
    if (field === "cost") return [redis.hincrbyfloat(key, field, value)];
    return [redis.hincrby(key, field, value)];
  });
}

function getUsageDelta(
  legacyUsage: RedisUsage | null,
  migratedLegacyUsage: RedisUsage,
) {
  const delta: RedisUsage = {};

  for (const field of usageFields) {
    const legacyValue = parseRedisNumber(legacyUsage?.[field]);
    const migratedValue = parseRedisNumber(migratedLegacyUsage[field]);
    const value = legacyValue - migratedValue;
    if (value > 0) delta[field] = value;
  }

  return delta;
}

function hasUsageData(usage: RedisUsage | null | undefined) {
  return usageFields.some((field) => parseRedisNumber(usage?.[field]) > 0);
}

async function getWeeklyUsageCostTotal(keys: string[]) {
  const { cost } = await readWeeklyCostTotals(keys);
  return cost;
}

async function readWeeklyCostTotals(keys: string[]) {
  const weeklyCosts = await readWeeklyCosts(keys);
  return weeklyCosts.reduce(
    (totals, { cost, triageCost }) => ({
      cost: totals.cost + cost,
      triageCost: totals.triageCost + triageCost,
    }),
    { cost: 0, triageCost: 0 },
  );
}

// Any number of daily hashes in one command.
async function readWeeklyCosts(
  keys: string[],
): Promise<Array<{ cost: number; triageCost: number }>> {
  if (!keys.length) return [];
  const costs = await redis.eval<string[], unknown[]>(
    readCostsScript,
    keys,
    [],
  );
  const values = Array.isArray(costs) ? costs : [];
  return keys.map((_, index) => ({
    cost: parseRedisNumber(values[2 * index]),
    triageCost: parseRedisNumber(values[2 * index + 1]),
  }));
}

function getWeeklyUsageCostKeys(userId: string, now: Date) {
  const days = getWeeklyUsageCostDays(now);
  return days.map((day) => getWeeklyUsageCostKey(userId, day));
}

function getWeeklyUsageCostDays(now: Date) {
  return Array.from({ length: WEEKLY_USAGE_COST_DAYS }, (_, offsetDays) => {
    const date = new Date(now);
    date.setUTCDate(now.getUTCDate() - offsetDays);
    return getUtcDay(date);
  });
}

function getWeeklyCostFlag(
  weeklyCostKey: string | null,
  spendBucket: AiSpendBucket,
) {
  if (!weeklyCostKey) return "0";
  return spendBucket === "triage" ? "2" : "1";
}

function getWeeklyUsageCostKey(userId: string, date: Date | string) {
  const day = typeof date === "string" ? date : getUtcDay(date);
  return `${WEEKLY_USAGE_COST_KEY_PREFIX}:user:${userId}:${day}`;
}

function getLegacyUsageKey(email: string) {
  return `usage:${email}`;
}

function getLegacyWeeklyUsageCostKey(email: string, date: Date | string) {
  const day = typeof date === "string" ? date : getUtcDay(date);
  return `${WEEKLY_USAGE_COST_KEY_PREFIX}:${email}:${day}`;
}

async function getLegacyWeeklyUsageCostsByDay({
  emails,
  now,
}: {
  emails: string[];
  now: Date;
}) {
  // Summed per day across the user's legacy addresses: what is stored about
  // a migration names days, never addresses (RD-3).
  const costsByDay = new Map<string, number>();
  if (!emails.length) return costsByDay;

  const days = getWeeklyUsageCostDays(now);
  const keys = emails.flatMap((email) =>
    days.map((day) => ({ day, key: getLegacyWeeklyUsageCostKey(email, day) })),
  );
  const costs = await readWeeklyCosts(keys.map(({ key }) => key));
  keys.forEach(({ day }, index) => {
    const cost = costs[index]?.cost ?? 0;
    if (cost > 0) costsByDay.set(day, (costsByDay.get(day) ?? 0) + cost);
  });

  return costsByDay;
}

function parseWeeklyUsageCostKey(key: string) {
  const prefix = `${WEEKLY_USAGE_COST_KEY_PREFIX}:`;
  if (!key.startsWith(prefix)) return null;

  const userPrefix = `${prefix}user:`;
  if (key.startsWith(userPrefix)) {
    const lastSeparatorIndex = key.lastIndexOf(":");
    if (lastSeparatorIndex <= userPrefix.length) return null;

    const userId = key.slice(userPrefix.length, lastSeparatorIndex);
    const day = key.slice(lastSeparatorIndex + 1);
    if (!userId || !day) return null;

    return { subject: `user:${userId}`, userId, day };
  }

  const lastSeparatorIndex = key.lastIndexOf(":");
  if (lastSeparatorIndex <= prefix.length) return null;

  const email = key.slice(prefix.length, lastSeparatorIndex);
  const day = key.slice(lastSeparatorIndex + 1);
  if (!email || !day) return null;

  return { subject: `email:${email}`, email, day };
}

function parseRedisNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number.parseFloat(raw) || 0;
  return 0;
}

function getUtcDay(date: Date) {
  return date.toISOString().slice(0, 10);
}

function mergeUsage(
  ...entries: Array<RedisUsage | null | undefined>
): RedisUsage {
  const merged: RedisUsage = {};

  for (const entry of entries) {
    if (!entry) continue;
    for (const field of usageFields) {
      const value = parseRedisNumber(entry[field]);
      if (value <= 0) continue;
      merged[field] = (merged[field] ?? 0) + value;
    }
  }

  return merged;
}

function maxUsage(
  currentUsage: RedisUsage | null | undefined,
  legacyUsage: RedisUsage | null | undefined,
) {
  const usage: RedisUsage = {};

  for (const field of usageFields) {
    const value = Math.max(
      parseRedisNumber(currentUsage?.[field]),
      parseRedisNumber(legacyUsage?.[field]),
    );
    if (value > 0) usage[field] = value;
  }

  return usage;
}

function getWeeklyCostIncrementOperations(
  userId: string,
  legacyCostsByDay: Map<string, number>,
) {
  return Array.from(legacyCostsByDay.entries()).flatMap(([day, cost]) => {
    const weeklyCostKey = getWeeklyUsageCostKey(userId, day);
    return [
      redis.hincrbyfloat(weeklyCostKey, "cost", cost),
      redis.expire(weeklyCostKey, WEEKLY_USAGE_COST_TTL_SECONDS),
    ];
  });
}

function getLegacyWeeklyCostDelta(
  legacyCostsByKey: Map<string, number>,
  migratedLegacyCostsByKey: Map<string, number>,
) {
  const delta = new Map<string, number>();

  for (const [key, cost] of legacyCostsByKey.entries()) {
    const value = cost - (migratedLegacyCostsByKey.get(key) ?? 0);
    if (value > 0) delta.set(key, value);
  }

  return delta;
}

function sumMapValues(map: Map<string, number>) {
  return Array.from(map.values()).reduce((sum, value) => sum + value, 0);
}

function getUsageMigrationDoneKey(migrationName: string) {
  return `usage-migration:${migrationName}:done`;
}

function getUsageMigrationLockKey(migrationName: string) {
  return `usage-migration:${migrationName}:lock`;
}

function parseLegacyUsageMigrationState(rawState: unknown): RedisUsage | null {
  if (typeof rawState !== "string") return null;

  try {
    const parsed = JSON.parse(rawState) as { usage?: Record<string, unknown> };
    return parsed.usage ? normalizeUsageFields(parsed.usage) : null;
  } catch {
    return null;
  }
}

function serializeLegacyUsageMigrationState(usage: RedisUsage) {
  const legacyUsage = Object.fromEntries(
    usageFields.flatMap((field) => {
      const value = usage[field];
      if (value === undefined) return [];

      return [[LEGACY_USAGE_FIELD_NAMES_BY_CURRENT[field] ?? field, value]];
    }),
  );

  return JSON.stringify({ usage: legacyUsage });
}

async function getRedisUsage(key: string): Promise<RedisUsage> {
  const raw = await redis.hgetall<Record<string, string>>(key);
  return normalizeUsageFields(raw);
}

function normalizeUsageFields(
  raw: Record<string, unknown> | null | undefined,
): RedisUsage {
  if (!raw) return {};

  const usageFieldNames = new Set<string>(usageFields);
  const usage: Record<string, number> = {};

  for (const [field, value] of Object.entries(raw)) {
    const normalizedField = LEGACY_USAGE_FIELD_NAMES[field] ?? field;
    if (!usageFieldNames.has(normalizedField)) continue;

    // During rolling deploys a hash may contain both the legacy openai* field
    // and its renamed counterpart, so colliding fields accumulate.
    usage[normalizedField] =
      parseRedisNumber(usage[normalizedField]) + parseRedisNumber(value);
  }

  return usage as RedisUsage;
}

function parseWeeklyUsageMigrationState(
  rawState: unknown,
): Map<string, number> | null {
  if (typeof rawState !== "string") return null;

  try {
    const parsed = JSON.parse(rawState) as {
      weeklyCostsByDay?: Record<string, string | number>;
      /** Before RD-3: keyed by the legacy key, which named the address. */
      weeklyCosts?: Record<string, string | number>;
    };
    if (parsed.weeklyCostsByDay)
      return new Map(
        Object.entries(parsed.weeklyCostsByDay).flatMap(([day, value]) => {
          const cost = parseRedisNumber(value);
          return cost > 0 ? [[day, cost]] : [];
        }),
      );
    if (!parsed.weeklyCosts) return null;

    const byDay = new Map<string, number>();
    for (const [key, value] of Object.entries(parsed.weeklyCosts)) {
      const day = parseWeeklyUsageCostKey(key)?.day;
      const cost = parseRedisNumber(value);
      if (day && cost > 0) byDay.set(day, (byDay.get(day) ?? 0) + cost);
    }
    return byDay;
  } catch {
    return null;
  }
}

function serializeWeeklyUsageMigrationState(costsByDay: Map<string, number>) {
  return JSON.stringify({ weeklyCostsByDay: Object.fromEntries(costsByDay) });
}
