import { after } from "next/server";
import { ensureEmailAccountsWatched } from "@/utils/email/watch-manager";
import { clearAccountDisconnectedErrorIfResolved } from "@/utils/error-messages";
import type { Logger } from "@/utils/logger";

/**
 * Registers push for a user's mailboxes once a linking callback has
 * responded, so new mail arrives from the moment a mailbox is linked instead
 * of waiting for the daily watch cron.
 */
export function scheduleWatchAfterLinking({
  targetUserId,
  logger,
}: {
  targetUserId: string;
  logger: Logger;
}) {
  after(() =>
    ensureEmailAccountsWatched({ userIds: [targetUserId], logger })
      .finally(() =>
        clearAccountDisconnectedErrorIfResolved({
          userId: targetUserId,
          logger,
        }),
      )
      .catch((error) => {
        logger.error("Failed to register email watches after account linking", {
          error,
        });
      }),
  );
}
