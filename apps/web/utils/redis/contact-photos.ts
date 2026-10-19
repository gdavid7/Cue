import "server-only";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

// Short enough that a newly granted contacts scope takes effect soon.
const FAILED_SWEEP_TTL_SECONDS = 15 * 60;

/**
 * Whether a recent address-book sweep for the account failed. Only that flag
 * is kept: the photos name the user's contacts, so the browser keeps them
 * (RD-3).
 */
export async function isContactPhotoSweepPaused(
  emailAccountId: string,
  logger: Logger,
) {
  try {
    return Boolean(await redis.get(getPausedKey(emailAccountId)));
  } catch (error) {
    logger.warn("Failed to read the contact photo sweep pause", { error });
    return false;
  }
}

// Stops a rate limited or unpermitted account from re-sweeping on every page
// load.
export async function pauseContactPhotoSweep(
  emailAccountId: string,
  logger: Logger,
) {
  try {
    await redis.set(getPausedKey(emailAccountId), "1", {
      ex: FAILED_SWEEP_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("Failed to pause the contact photo sweep", { error });
  }
}

function getPausedKey(emailAccountId: string) {
  return `contact-photos-paused:${emailAccountId}`;
}
