import "server-only";
import { randomUUID } from "node:crypto";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";
import { clearOwnedLock } from "@/utils/redis/owned-lock";

const GMAIL_HISTORY_CATCH_UP_KEY_PREFIX = "gmail-history-catch-up";
const GMAIL_HISTORY_CATCH_UP_TTL_SECONDS = 24 * 60 * 60;
// Catch-ups come a minute or two apart, so runs within an hour are in a row.
const EMPTY_HISTORY_RUNS_TTL_SECONDS = 60 * 60;

// Failures only cost the wider catch-up window, so they never fail the webhook.
// Shares the rate-limit state's Redis check: without that state, webhooks never
// skip history, so there is nothing to catch up on.

/**
 * Records that webhook history was left unprocessed because Gmail was rate
 * limiting the account. Each mark gets a new token so a catch-up run only
 * clears the mark it read, not one set by a webhook skipped during that run.
 * Resolves whether the mark was stored; a catch-up only runs while it is.
 */
export async function markGmailHistoryCatchUp(
  emailAccountId: string,
  logger: Logger,
): Promise<boolean> {
  if (!isEmailProviderRateLimitRedisConfigured()) return false;

  try {
    await redis.set(getGmailHistoryCatchUpKey(emailAccountId), randomUUID(), {
      ex: GMAIL_HISTORY_CATCH_UP_TTL_SECONDS,
    });
    return true;
  } catch (error) {
    logger.warn("Failed to mark Gmail history catch-up", { error });
    return false;
  }
}

export async function getGmailHistoryCatchUp(
  emailAccountId: string,
  logger: Logger,
): Promise<string | null> {
  if (!isEmailProviderRateLimitRedisConfigured()) return null;

  try {
    return await redis.get<string>(getGmailHistoryCatchUpKey(emailAccountId));
  } catch (error) {
    logger.warn("Failed to read Gmail history catch-up", { error });
    return null;
  }
}

export async function clearGmailHistoryCatchUp({
  emailAccountId,
  token,
  logger,
}: {
  emailAccountId: string;
  token: string;
  logger: Logger;
}) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;

  try {
    await clearOwnedLock({
      key: getGmailHistoryCatchUpKey(emailAccountId),
      lockToken: token,
    });
  } catch (error) {
    logger.warn("Failed to clear Gmail history catch-up", { error });
  }
}

// History ids can pass 2^53, beyond Lua's and JSON's numbers, so they are
// compared as digit strings and stored with a prefix that keeps the Redis
// client from parsing them as numbers.
const TARGET_PREFIX = "h";
const RAISE_TARGET_SCRIPT = `
local stored = redis.call("GET", KEYS[1])
local requested = ARGV[1]
if stored then
  local current = string.sub(stored, 2)
  if #current > #requested or (#current == #requested and current >= requested) then
    return 0
  end
end
redis.call("SET", KEYS[1], "${TARGET_PREFIX}" .. requested, "EX", tonumber(ARGV[2]))
return 1
`;

/**
 * Raises the history id catch-ups must reach to at least `historyId`.
 * Deliveries in one scheduling window share one body, and a run's cursor can
 * pass the id a delivery names, so the catch-up compares against this.
 */
export async function raiseGmailHistoryCatchUpTarget(
  emailAccountId: string,
  historyId: string,
  logger: Logger,
) {
  if (!isEmailProviderRateLimitRedisConfigured()) return;

  try {
    await redis.eval(
      RAISE_TARGET_SCRIPT,
      [getCatchUpTargetKey(emailAccountId)],
      [
        // The script compares by length first, so no leading zeros.
        BigInt(historyId).toString(),
        String(GMAIL_HISTORY_CATCH_UP_TTL_SECONDS),
      ],
    );
  } catch (error) {
    logger.warn("Failed to record Gmail history catch-up target", { error });
  }
}

export async function getGmailHistoryCatchUpTarget(
  emailAccountId: string,
  logger: Logger,
): Promise<string | null> {
  if (!isEmailProviderRateLimitRedisConfigured()) return null;

  try {
    const stored = await redis.get<string>(getCatchUpTargetKey(emailAccountId));
    const target = stored?.slice(TARGET_PREFIX.length);
    return target && /^\d+$/.test(target) ? target : null;
  } catch (error) {
    logger.warn("Failed to read Gmail history catch-up target", { error });
    return null;
  }
}

function getCatchUpTargetKey(emailAccountId: string) {
  return `gmail-history-catch-up-target:${emailAccountId}`;
}

/**
 * Counts runs in a row that read their page limit of Gmail history without
 * finding a record, so they can stop retrying the same empty pages. Without
 * Redis every run counts as the first.
 */
export async function countEmptyGmailHistoryRun(
  emailAccountId: string,
  logger: Logger,
): Promise<number> {
  try {
    const key = getEmptyHistoryRunsKey(emailAccountId);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, EMPTY_HISTORY_RUNS_TTL_SECONDS);
    return count;
  } catch (error) {
    logger.warn("Failed to count empty Gmail history run", { error });
    return 1;
  }
}

export async function clearEmptyGmailHistoryRuns(
  emailAccountId: string,
  logger: Logger,
) {
  try {
    await redis.del(getEmptyHistoryRunsKey(emailAccountId));
  } catch (error) {
    logger.warn("Failed to clear empty Gmail history runs", { error });
  }
}

function getEmptyHistoryRunsKey(emailAccountId: string) {
  return `gmail-history-empty-runs:${emailAccountId}`;
}

function getGmailHistoryCatchUpKey(emailAccountId: string) {
  return `${GMAIL_HISTORY_CATCH_UP_KEY_PREFIX}:${emailAccountId}`;
}
