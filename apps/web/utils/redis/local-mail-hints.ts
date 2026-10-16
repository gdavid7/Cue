import "server-only";
import { redis } from "@/utils/redis";
import type { Logger } from "@/utils/logger";

export function localMailHintChannel(emailAccountId: string) {
  return `local-mail:${emailAccountId}`;
}

// Not coalesced here: a dropped hint leaves a second email unseen until the
// client's idle catch-up. Each provider push costs one publish, and the
// client's engine folds hints that arrive during a sync into one more read, so
// a burst of pushes still costs the mailbox a single catch-up.
export async function publishLocalMailHint(
  emailAccountId: string,
  logger: Logger,
) {
  await publishHint(emailAccountId, "{}", logger);
}

export const TRACKER_HINT_MESSAGE = '{"kind":"trackers"}';

// Cue changed what needs a reply or who the user is waiting on, so an open
// Today reloads its lanes. The mailbox itself did not change.
export async function publishTrackerHint(
  emailAccountId: string,
  logger: Logger,
) {
  await publishHint(emailAccountId, TRACKER_HINT_MESSAGE, logger);
}

async function publishHint(
  emailAccountId: string,
  message: string,
  logger: Logger,
) {
  // One command whether or not a client listens: checking for listeners
  // first would cost as much as publishing to none.
  try {
    await redis.publish(localMailHintChannel(emailAccountId), message);
  } catch (error) {
    logger.warn("Failed to publish local mail hint", { error });
  }
}
