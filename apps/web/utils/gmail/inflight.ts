import type { GmailQuotaPriority as Priority } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import { timeRequestDependency } from "@/utils/request-metrics";

// Gmail limits how many requests one user has in flight at once, across every
// client, and counts each request inside a batch toward it; it answers past
// that with 429 "Too many concurrent requests for user". Google publishes no
// number, only that many parallel requests or large batches trigger it, so
// this stays under the roughly ten that triggers it in practice. The quota
// gate already paces units per second across instances, which bounds how much
// all instances keep in flight together; what it cannot see is a burst inside
// one instance, where a sync run, engine hydration, a search, a webhook and a
// bulk action all send at once. So the cap is per account per instance, in
// memory: one Redis round trip per Gmail call is what the gate's leases exist
// to avoid.
export const GMAIL_INFLIGHT_LIMIT = 8;
// Sync and background together never take the last two slots, so a person's
// call waits only behind other calls of theirs, or one round trip at most.
// Background alone takes at most three, so sync always has room beside it.
const SYNC_SHARE = 6;
const BACKGROUND_SHARE = 3;
// A call that waits this long is sent anyway, over the cap: a stuck request
// must never hold a person's thread or search, nor stall a sync for good.
export const GMAIL_INFLIGHT_MAX_WAIT_MS: Record<Priority, number> = {
  interactive: 2000,
  sync: 30_000,
  background: 30_000,
};
const RANK: Record<Priority, number> = {
  interactive: 0,
  sync: 1,
  background: 2,
};

type Waiter = {
  priority: Priority;
  permits: number;
  grant: () => void;
};
type AccountSlots = {
  inflight: Record<Priority, number>;
  waiters: Waiter[];
};

const logger = createScopedLogger("gmail-inflight");
const accounts = new Map<string, AccountSlots>();
const stats = { waits: 0, waitMsTotal: 0, waitMsMax: 0, overCap: 0 };

/**
 * The most requests one call at `priority` may send at once, such as the
 * requests in one HTTP batch. Larger sets must be split to fit.
 */
export function gmailInflightBatchLimit(priority: Priority) {
  return priority === "background" ? BACKGROUND_SHARE : SYNC_SHARE;
}

/**
 * Sends one Gmail request (or one batch of `weight` requests) while holding
 * that many of the account's in-flight slots, released when `send` settles.
 * `send` must be the network round trip alone and make no Gmail calls of its
 * own; quota waits and retry sleeps stay outside it. A streamed response
 * releases its slots once its headers arrive, before its body is read.
 */
export async function withGmailInflightSlot<T>(
  {
    emailAccountId,
    priority,
    weight = 1,
    signal,
  }: {
    emailAccountId: string | undefined;
    priority: Priority;
    weight?: number;
    signal?: AbortSignal;
  },
  send: () => Promise<T>,
): Promise<T> {
  if (!emailAccountId) return send();
  // Gmail counts every request, so a larger set is the caller's to split.
  if (weight > gmailInflightBatchLimit(priority))
    throw new Error(
      `Gmail in-flight weight ${weight} exceeds ${gmailInflightBatchLimit(priority)} at ${priority}`,
    );

  const account = accounts.get(emailAccountId) ?? {
    inflight: { interactive: 0, sync: 0, background: 0 },
    waiters: [],
  };
  accounts.set(emailAccountId, account);
  const permits = Math.max(1, Math.ceil(weight));
  await acquire(emailAccountId, account, priority, permits, signal);
  try {
    return await send();
  } finally {
    account.inflight[priority] -= permits;
    grantWaiters(account);
    if (total(account) <= 0 && account.waiters.length === 0)
      accounts.delete(emailAccountId);
  }
}

/** What callers met at the cap since the last call, for the gate summary. */
export function takeGmailInflightStats() {
  const taken = { ...stats };
  stats.waits = 0;
  stats.waitMsTotal = 0;
  stats.waitMsMax = 0;
  stats.overCap = 0;
  return taken;
}

/** Forgets every account's slots, as a fresh instance would start. For tests. */
export function resetGmailInflightState() {
  accounts.clear();
  takeGmailInflightStats();
}

async function acquire(
  emailAccountId: string,
  account: AccountSlots,
  priority: Priority,
  permits: number,
  signal: AbortSignal | undefined,
) {
  signal?.throwIfAborted();
  const queuedAhead = account.waiters.some(
    (waiter) => RANK[waiter.priority] <= RANK[priority],
  );
  if (!queuedAhead && fits(account, priority, permits)) {
    account.inflight[priority] += permits;
    return;
  }

  const startedAt = Date.now();
  const granted = await timeRequestDependency(
    "wait",
    () =>
      new Promise<boolean>((resolve, reject) => {
        const remove = () => {
          const index = account.waiters.indexOf(waiter);
          if (index !== -1) account.waiters.splice(index, 1);
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          // The waiter may have been the head holding back calls that now fit.
          grantWaiters(account);
        };
        const onAbort = () => {
          remove();
          if (total(account) <= 0 && account.waiters.length === 0)
            accounts.delete(emailAccountId);
          reject(signal?.reason);
        };
        const waiter: Waiter = {
          priority,
          permits,
          grant: () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            resolve(true);
          },
        };
        const timer = setTimeout(() => {
          remove();
          account.inflight[priority] += permits;
          resolve(false);
        }, GMAIL_INFLIGHT_MAX_WAIT_MS[priority]);
        signal?.addEventListener("abort", onAbort, { once: true });
        // Higher priorities first, arrival order within one.
        const before = account.waiters.findIndex(
          (other) => RANK[other.priority] > RANK[priority],
        );
        account.waiters.splice(
          before === -1 ? account.waiters.length : before,
          0,
          waiter,
        );
      }),
  );

  const waitedMs = Date.now() - startedAt;
  stats.waits += 1;
  stats.waitMsTotal += waitedMs;
  stats.waitMsMax = Math.max(stats.waitMsMax, waitedMs);
  if (!granted) {
    stats.overCap += 1;
    logger.warn("Sent Gmail call over the in-flight cap after waiting", {
      emailAccountId,
      priority,
      permits,
      inflight: total(account),
      waitedMs,
    });
  }
}

// Each share counts only the calls it limits: a sync call is judged by what
// sync and background hold, not by a person's calls in the reserved slots, so
// a steady trickle of reads cannot keep a sync batch waiting.
function fits(account: AccountSlots, priority: Priority, permits: number) {
  const { interactive, sync, background } = account.inflight;
  if (interactive + sync + background + permits > GMAIL_INFLIGHT_LIMIT)
    return false;
  if (priority === "interactive") return true;
  if (sync + background + permits > SYNC_SHARE) return false;
  return priority === "sync" || background + permits <= BACKGROUND_SHARE;
}

// Grants in queue order and stops at the first that does not fit, so a later,
// smaller call never overtakes a waiting person's call.
function grantWaiters(account: AccountSlots) {
  while (account.waiters.length > 0) {
    const next = account.waiters[0];
    if (!fits(account, next.priority, next.permits)) return;
    account.waiters.shift();
    account.inflight[next.priority] += next.permits;
    next.grant();
  }
}

function total(account: AccountSlots) {
  const { interactive, sync, background } = account.inflight;
  return interactive + sync + background;
}
