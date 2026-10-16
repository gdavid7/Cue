import "server-only";
import type { Logger } from "@/utils/logger";
import { acquireOwnedLock, clearOwnedLock } from "@/utils/redis/owned-lock";

// As long as the history routes may run, so a run that dies without releasing
// holds the account no longer than it could have kept running.
const LEASE_TTL_SECONDS = 300;

type Lease = { acquired: true; token: string | null } | { acquired: false };

/**
 * One history run per account at a time. Overlapping runs (a push and a
 * catch-up) would each count a message the other holds as handled and move
 * the cursor past it, and apply label learning twice.
 */
export async function acquireGmailHistoryLease(
  emailAccountId: string,
  logger: Logger,
): Promise<Lease> {
  try {
    const token = await acquireOwnedLock({
      key: getLeaseKey(emailAccountId),
      processingTtlSeconds: LEASE_TTL_SECONDS,
    });
    return token ? { acquired: true, token } : { acquired: false };
  } catch (error) {
    // Without Redis the per-message locks are gone too; run as before.
    logger.warn("Failed to acquire Gmail history lease", { error });
    return { acquired: true, token: null };
  }
}

export async function releaseGmailHistoryLease(
  emailAccountId: string,
  lease: Lease,
  logger: Logger,
) {
  if (!lease.acquired || !lease.token) return;
  try {
    await clearOwnedLock({
      key: getLeaseKey(emailAccountId),
      lockToken: lease.token,
    });
  } catch (error) {
    logger.warn("Failed to release Gmail history lease", { error });
  }
}

function getLeaseKey(emailAccountId: string) {
  return `gmail-history-lease:${emailAccountId}`;
}
