import type {
  ActivationSignal,
  ActivationSignalBody,
} from "@/utils/actions/activation.validation";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

/**
 * Activation events behind the beta's success metrics (aha, activated,
 * retained), queried in Axiom: see docs/metrics/activation.md. They are info
 * logs in the "product" scope whose message is the event name. Fields are the
 * mailbox id, timestamps and aggregate counts only, never addresses, subjects
 * or content.
 *
 * The unit is the mailbox (emailAccountId), the only id the events carry, so
 * every metric joins on it. A mailbox's first sign-in is its
 * EmailAccount.createdAt.
 */
export const ACTIVATION_EVENTS = {
  firstSignIn: "activation.first_sign_in",
  needsReplyFirstItem: "activation.needs_reply_first_item",
  firstSuggestedReplySent: "activation.first_suggested_reply_sent",
  firstSyncReady: "activation.first_sync_ready",
  firstThreadOpened: "activation.first_thread_opened",
  firstTriageAction: "activation.first_triage_action",
  firstWaitingOnYouItem: "activation.first_waiting_on_you_item",
  activeDay: "activation.active_day",
  firstHourHealth: "activation.first_hour_health",
} as const;

const logger = createScopedLogger("product");

// A first's key outlives every metric window by far, then expires.
const FIRST_EVENT_TTL_SECONDS = 400 * 24 * 60 * 60;
// One day key outlives its UTC day wherever the request lands, then expires.
const ACTIVE_DAY_TTL_SECONDS = 2 * 24 * 60 * 60;
const MAX_CLAIMED_KEYS = 1000;
// Keys this instance already claimed, so repeat calls skip Redis.
const claimedKeys = new Map<string, true>();

/**
 * Called only where a mailbox is created. The claim still guards it, so two
 * racing creations log it once.
 */
export async function recordFirstSignIn(emailAccountId: string) {
  try {
    if (!(await claimOnce(`activation:first-sign-in:${emailAccountId}`)))
      return;
    logger.info(ACTIVATION_EVENTS.firstSignIn, {
      emailAccountId,
      at: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.firstSignIn,
      error,
    });
  }
}

/** The first time Needs reply has an item, measured from first sign-in. */
export async function recordNeedsReplyFirstItem(emailAccountId: string) {
  try {
    if (
      !(await claimOnce(`activation:needs-reply-first-item:${emailAccountId}`))
    )
      return;
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { createdAt: true },
    });
    if (!emailAccount) return;
    const now = new Date();
    logger.info(ACTIVATION_EVENTS.needsReplyFirstItem, {
      emailAccountId,
      at: now.toISOString(),
      firstSignInAt: emailAccount.createdAt.toISOString(),
      msSinceFirstSignIn: now.getTime() - emailAccount.createdAt.getTime(),
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.needsReplyFirstItem,
      error,
    });
  }
}

/** The first reply sent that started from a reply Cue wrote. */
export async function recordFirstSuggestedReplySent(emailAccountId: string) {
  try {
    if (
      !(await claimOnce(
        `activation:first-suggested-reply-sent:${emailAccountId}`,
      ))
    )
      return;
    logger.info(ACTIVATION_EVENTS.firstSuggestedReplySent, {
      emailAccountId,
      at: new Date().toISOString(),
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.firstSuggestedReplySent,
      error,
    });
  }
}

/** The mail engine finished a first sync of the mailbox, reported by the client. */
export async function recordFirstSyncReady(emailAccountId: string) {
  try {
    if (!(await claimOnce(`activation:first-sync-ready:${emailAccountId}`)))
      return;
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { createdAt: true },
    });
    if (!emailAccount) return;
    const now = new Date();
    logger.info(ACTIVATION_EVENTS.firstSyncReady, {
      emailAccountId,
      at: now.toISOString(),
      firstSignInAt: emailAccount.createdAt.toISOString(),
      msSinceFirstSignIn: now.getTime() - emailAccount.createdAt.getTime(),
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.firstSyncReady,
      error,
    });
  }
}

/**
 * Today first showed Waiting on you from the browser's local mail, measured
 * from first sign-in, with how many rows showed and how long Today took.
 */
export async function recordFirstWaitingOnYouItem(
  emailAccountId: string,
  {
    itemCount,
    msSinceTodayOpened,
  }: Pick<ActivationSignalBody, "itemCount" | "msSinceTodayOpened">,
) {
  try {
    if (
      !(await claimOnce(
        `activation:first-waiting-on-you-item:${emailAccountId}`,
      ))
    )
      return;
    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { createdAt: true },
    });
    if (!emailAccount) return;
    const now = new Date();
    logger.info(ACTIVATION_EVENTS.firstWaitingOnYouItem, {
      emailAccountId,
      at: now.toISOString(),
      firstSignInAt: emailAccount.createdAt.toISOString(),
      msSinceFirstSignIn: now.getTime() - emailAccount.createdAt.getTime(),
      itemCount,
      msSinceTodayOpened,
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.firstWaitingOnYouItem,
      error,
    });
  }
}

/** At most once per mailbox per UTC day. */
export async function recordActiveDay(emailAccountId: string) {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (
      !(await claimOnce(
        `activation:active-day:${emailAccountId}:${day}`,
        ACTIVE_DAY_TTL_SECONDS,
      ))
    )
      return;
    logger.info(ACTIVATION_EVENTS.activeDay, {
      emailAccountId,
      at: now.toISOString(),
      day,
    });
  } catch (error) {
    logger.warn("Failed to record activation event", {
      event: ACTIVATION_EVENTS.activeDay,
      error,
    });
  }
}

function recordFirstOnce(event: string, claim: string) {
  return async (emailAccountId: string) => {
    try {
      if (!(await claimOnce(`activation:${claim}:${emailAccountId}`))) return;
      logger.info(event, { emailAccountId, at: new Date().toISOString() });
    } catch (error) {
      logger.warn("Failed to record activation event", { event, error });
    }
  };
}

/** Whether this call is the first to claim the key across all instances. */
async function claimOnce(key: string, ttlSeconds = FIRST_EVENT_TTL_SECONDS) {
  if (claimedKeys.has(key)) return false;
  const claimed = await redis.set(key, "1", { nx: true, ex: ttlSeconds });
  claimedKeys.set(key, true);
  if (claimedKeys.size > MAX_CLAIMED_KEYS) {
    const oldest = claimedKeys.keys().next().value;
    if (oldest) claimedKeys.delete(oldest);
  }
  return claimed === "OK";
}

/** What the signed-in client may report, each claimed once per mailbox. */
export const ACTIVATION_SIGNAL_RECORDERS: Record<
  ActivationSignal,
  (emailAccountId: string, signal: ActivationSignalBody) => Promise<void>
> = {
  first_sync_ready: recordFirstSyncReady,
  first_thread_opened: recordFirstOnce(
    ACTIVATION_EVENTS.firstThreadOpened,
    "first-thread-opened",
  ),
  first_triage_action: recordFirstOnce(
    ACTIVATION_EVENTS.firstTriageAction,
    "first-triage-action",
  ),
  first_waiting_on_you_item: recordFirstWaitingOnYouItem,
};
