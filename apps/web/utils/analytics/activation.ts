import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

/**
 * Activation events behind the beta's success metrics (aha, activated,
 * retained), queried in Axiom: see docs/metrics/activation.md. They are info
 * logs in the "product" scope whose message is the event name. Fields are the
 * mailbox id and timestamps only, never addresses, subjects or content.
 *
 * The unit is the mailbox (emailAccountId), the only id the events carry, so
 * every metric joins on it. A mailbox's first sign-in is its
 * EmailAccount.createdAt.
 */
export const ACTIVATION_EVENTS = {
  firstSignIn: "activation.first_sign_in",
  needsReplyFirstItem: "activation.needs_reply_first_item",
  firstSuggestedReplySent: "activation.first_suggested_reply_sent",
  activeDay: "activation.active_day",
} as const;

const logger = createScopedLogger("product");

// One day key outlives its UTC day wherever the request lands, then expires.
const ACTIVE_DAY_TTL_SECONDS = 2 * 24 * 60 * 60;
const MAX_CLAIMED_KEYS = 1000;
// Keys this instance already claimed, so repeat calls skip Redis.
const claimedKeys = new Map<string, true>();

/**
 * Called only where a mailbox is created, so it fires once per mailbox
 * without any stored marker.
 */
export function logFirstSignIn(emailAccountId: string) {
  logger.info(ACTIVATION_EVENTS.firstSignIn, {
    emailAccountId,
    at: new Date().toISOString(),
  });
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

/**
 * Whether this call is the first to claim the key across all instances.
 * First-time keys never expire, so a "first" can't fire twice.
 */
async function claimOnce(key: string, ttlSeconds?: number) {
  if (claimedKeys.has(key)) return false;
  const claimed = await redis.set(
    key,
    "1",
    ttlSeconds ? { nx: true, ex: ttlSeconds } : { nx: true },
  );
  claimedKeys.set(key, true);
  if (claimedKeys.size > MAX_CLAIMED_KEYS) {
    const oldest = claimedKeys.keys().next().value;
    if (oldest) claimedKeys.delete(oldest);
  }
  return claimed === "OK";
}
