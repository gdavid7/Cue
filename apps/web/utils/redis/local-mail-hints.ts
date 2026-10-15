import "server-only";
import { redis } from "@/utils/redis";
import type { Logger } from "@/utils/logger";

export function localMailHintChannel(emailAccountId: string) {
  return `local-mail:${emailAccountId}`;
}

export async function refreshLocalMailInterest(emailAccountId: string) {
  await redis.set(`local-mail-interest:${emailAccountId}`, "1", { ex: 75 });
}

// Not coalesced here: a dropped hint leaves a second email unseen until the
// client's idle catch-up. Each provider push costs one publish, and the
// client's engine folds hints that arrive during a sync into one more read, so
// a burst of pushes still costs the mailbox a single catch-up.
export async function publishLocalMailHint(
  emailAccountId: string,
  logger: Logger,
) {
  try {
    if (!(await redis.exists(`local-mail-interest:${emailAccountId}`))) return;
    await redis.publish(localMailHintChannel(emailAccountId), "{}");
  } catch (error) {
    logger.warn("Failed to publish local mail hint", { error });
  }
}
