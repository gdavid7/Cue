import "server-only";
import { redis } from "@/utils/redis";
import type { Logger } from "@/utils/logger";

export function localMailHintChannel(emailAccountId: string) {
  return `local-mail:${emailAccountId}`;
}

/**
 * Changes on each provider push, so a browser with no stream open can ask
 * whether anything happened with one read instead of syncing to find out.
 */
export function localMailVersionKey(emailAccountId: string) {
  return `local-mail-version:${emailAccountId}`;
}

// Longer than a browser stays closed between polls; a lapsed key reads as a
// change once, which costs one catch-up.
const VERSION_TTL_SECONDS = 7 * 24 * 60 * 60;

// One script, so a push still costs a single command: the version a polling
// browser reads, and the hint an open stream hears.
const PUBLISH_MAILBOX_HINT_SCRIPT = `
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return redis.call('PUBLISH', ARGV[3], ARGV[4])
`;

// Not coalesced here: a dropped hint leaves a second email unseen until the
// client's idle catch-up. Each provider push costs one command, and the
// client's engine folds hints that arrive during a sync into one more read, so
// a burst of pushes still costs the mailbox a single catch-up.
export async function publishLocalMailHint(
  emailAccountId: string,
  logger: Logger,
) {
  try {
    await redis.eval(
      PUBLISH_MAILBOX_HINT_SCRIPT,
      [localMailVersionKey(emailAccountId)],
      [
        // Unique per push; readers compare versions for equality, not order.
        `${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 8)}`,
        String(VERSION_TTL_SECONDS),
        localMailHintChannel(emailAccountId),
        "{}",
      ],
    );
  } catch (error) {
    logger.warn("Failed to publish local mail hint", { error });
  }
}

export const TRACKER_HINT_MESSAGE = '{"kind":"trackers"}';

// Cue changed what needs a reply or who the user is waiting on, so an open
// Today reloads its lanes. The mailbox itself did not change, so the version
// stays: only an open stream needs to hear it.
export async function publishTrackerHint(
  emailAccountId: string,
  logger: Logger,
) {
  // One command whether or not a client listens: checking for listeners
  // first would cost as much as publishing to none.
  try {
    await redis.publish(
      localMailHintChannel(emailAccountId),
      TRACKER_HINT_MESSAGE,
    );
  } catch (error) {
    logger.warn("Failed to publish local mail hint", { error });
  }
}
