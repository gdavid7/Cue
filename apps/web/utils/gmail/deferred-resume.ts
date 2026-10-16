import { getGmailCallDeferredError } from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import { publishToQstashAt } from "@/utils/upstash";

// The quota gate defers for seconds to a minute, so a handful of tries spans
// the minutes a busy account needs to settle.
const MAX_GMAIL_DEFERRALS = 5;

/**
 * A background job the Gmail quota gate deferred is delivered to `path` again
 * once the deferral's retry-after has passed, with `deferrals` counting how
 * many times it was put off. Returns false when `error` is not a deferral, so
 * the caller handles it as before.
 */
export async function resumeAfterGmailDeferral<
  T extends Record<string, unknown>,
>({
  error,
  path,
  body,
  deferrals,
  jobKey,
  job,
  logger,
}: {
  error: unknown;
  path: string;
  body: T;
  deferrals: number;
  /** Identifies this run, so a duplicate schedule of one resume collapses. */
  jobKey: string;
  /** What the job does, for logs. */
  job: string;
  logger: Logger;
}): Promise<boolean> {
  const deferred = getGmailCallDeferredError(error);
  if (!deferred) return false;
  const { retryAfterMs } = deferred;

  if (deferrals >= MAX_GMAIL_DEFERRALS) {
    logger.warn(`Gave up on ${job}: the Gmail quota gate kept deferring it`, {
      deferrals,
      retryAfterMs,
    });
    return true;
  }

  const nextDeferrals = deferrals + 1;
  try {
    const scheduled = await publishToQstashAt({
      path,
      body: { ...body, deferrals: nextDeferrals },
      notBefore: new Date(Date.now() + retryAfterMs),
      deduplicationId: `${jobKey}-${nextDeferrals}`,
    });
    if (scheduled) {
      logger.info(`Deferred ${job} by Gmail quota; resume scheduled`, {
        deferrals: nextDeferrals,
        retryAfterMs,
      });
    } else {
      logger.warn(
        `Deferred ${job} by Gmail quota and no scheduler is configured to resume it`,
        { retryAfterMs },
      );
    }
  } catch (scheduleError) {
    logger.warn(`Failed to schedule resume of ${job}`, {
      error: scheduleError,
    });
  }
  return true;
}
