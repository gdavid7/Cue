import type { Logger } from "@/utils/logger";
import { publishToQstashAt } from "@/utils/upstash";

export const GMAIL_HISTORY_CATCH_UP_PATH = "/api/google/webhook/catch-up";

// Long enough for the account's Gmail budget to refill past what held the
// history back, short enough that the mail is not noticeably late.
const CATCH_UP_DELAY_MS = 90_000;

/**
 * Processes the account's history again shortly after the Gmail quota gate
 * deferred it, so a quiet mailbox does not wait hours for its next push.
 * Deferrals within one delay window share a single delivery, and a delivery
 * does nothing once a later push has caught up.
 */
export async function scheduleGmailHistoryCatchUp({
  emailAccountId,
  historyId,
  logger,
}: {
  emailAccountId: string;
  historyId: string;
  logger: Logger;
}) {
  const notBefore = new Date(Date.now() + CATCH_UP_DELAY_MS);
  const window = Math.floor(notBefore.getTime() / CATCH_UP_DELAY_MS);
  try {
    const scheduled = await publishToQstashAt({
      path: GMAIL_HISTORY_CATCH_UP_PATH,
      body: { emailAccountId, historyId },
      notBefore,
      deduplicationId: `gmail-history-catch-up-${emailAccountId}-${window}`,
    });
    if (!scheduled)
      logger.info(
        "No scheduler for the Gmail history catch-up; the next push catches up",
      );
  } catch (error) {
    logger.warn("Failed to schedule Gmail history catch-up", { error });
  }
}
