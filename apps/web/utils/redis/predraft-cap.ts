import { createHash } from "node:crypto";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

/** Reply suggestions Cue writes ahead of time per email account per UTC day. */
export const PREDRAFTS_PER_ACCOUNT_PER_DAY = 20;

const KEY_PREFIX = "predraft-cap:v1";
const MESSAGE_KEY_PREFIX = "predraft-message:v1";
// Outlives its day, so a slot can't be claimed twice across the boundary.
const KEY_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Takes one of the account's pre-draft slots for today, atomically: of any
 * number of concurrent callers, at most the cap get one. The key holds only
 * the account ID and the date, never anything from the mail.
 *
 * Fails closed: without Redis, or when it errors, nothing is pre-drafted,
 * since each pre-draft is a model call no one asked for.
 */
export async function claimPredraftSlot({
  emailAccountId,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  logger: Logger;
  now?: Date;
}): Promise<boolean> {
  if (!env.REDIS_HTTP_URL || !env.REDIS_HTTP_TOKEN) return false;
  try {
    const count = Number(
      await redis.eval<string[], number>(
        CLAIM_SCRIPT,
        [getPredraftCapKey(emailAccountId, now)],
        [KEY_TTL_SECONDS.toString()],
      ),
    );
    return count <= PREDRAFTS_PER_ACCOUNT_PER_DAY;
  } catch (error) {
    logger.warn("Pre-draft cap unavailable", { error });
    return false;
  }
}

/**
 * Claims one message for a pre-draft, so concurrent webhooks for it write
 * one. The key holds the account ID and a hash of the message ID only.
 * Fails closed, like the daily cap.
 */
export async function claimPredraftMessage({
  emailAccountId,
  messageId,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  logger: Logger;
}): Promise<boolean> {
  if (!env.REDIS_HTTP_URL || !env.REDIS_HTTP_TOKEN) return false;
  try {
    const digest = createHash("sha256").update(messageId).digest("hex");
    const claimed = await redis.set(
      `${MESSAGE_KEY_PREFIX}:${emailAccountId}:${digest}`,
      "1",
      { nx: true, ex: KEY_TTL_SECONDS },
    );
    return claimed === "OK";
  } catch (error) {
    logger.warn("Pre-draft message claim unavailable", { error });
    return false;
  }
}

export function getPredraftCapKey(emailAccountId: string, now: Date) {
  return `${KEY_PREFIX}:${emailAccountId}:${now.toISOString().slice(0, 10)}`;
}

const CLAIM_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], tonumber(ARGV[1]))
end
return count
`.trim();
