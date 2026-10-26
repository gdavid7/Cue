import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

// Outlives the window in which mail sync still treats a message as new, so a
// message the user moves back after Cue moved it is never moved again.
const CLAIM_TTL_SECONDS = 2 * 24 * 60 * 60;

/**
 * Claims the one move Cue makes when a message arrives in a muted or snoozed
 * conversation: archiving it, or waking the conversation. The webhook and
 * every device's mail sync can each see the same message, and only the first
 * acts. The key holds only the account and message IDs (R-1).
 *
 * `taken` means another path already moved it. `unavailable` means Redis
 * couldn't say, and each caller decides whether to act anyway.
 */
export async function claimNewMailReaction({
  emailAccountId,
  messageId,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  logger: Logger;
}): Promise<"claimed" | "taken" | "unavailable"> {
  try {
    const result = await redis.set(
      getKey(emailAccountId, messageId),
      "claimed",
      { ex: CLAIM_TTL_SECONDS, nx: true },
    );
    return result === "OK" ? "claimed" : "taken";
  } catch (error) {
    logger.warn("Failed to claim a new message's move", { error });
    return "unavailable";
  }
}

/** Lets a later run try again after the move failed. */
export async function releaseNewMailReaction({
  emailAccountId,
  messageId,
  logger,
}: {
  emailAccountId: string;
  messageId: string;
  logger: Logger;
}) {
  try {
    await redis.del(getKey(emailAccountId, messageId));
  } catch (error) {
    logger.warn("Failed to release a new message's move", { error });
  }
}

function getKey(emailAccountId: string, messageId: string) {
  return `new-mail-reaction:v1:${emailAccountId}:${messageId}`;
}
