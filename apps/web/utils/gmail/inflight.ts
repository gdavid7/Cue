import { AsyncLocalStorage } from "node:async_hooks";
import type { GmailQuotaPriority as Priority } from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";

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
// Sync and background never take the last slots, so a person's call waits
// only behind other calls of theirs, or one round trip at most.
const CEILING: Record<Priority, number> = {
  interactive: GMAIL_INFLIGHT_LIMIT,
  sync: 6,
  background: 3,
};
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
type AccountSlots = { inflight: number; waiters: Waiter[] };

const logger = createScopedLogger("gmail-inflight");
const accounts = new Map<string, AccountSlots>();
// Accounts whose slot the current async call already holds: a call made while
// holding one runs on it rather than wait for a slot it would never get.
const heldSlots = new AsyncLocalStorage<ReadonlySet<string>>();
const stats = { waits: 0, waitMsTotal: 0, waitMsMax: 0, overCap: 0 };

/**
 * Sends one Gmail request (or one batch of `weight` requests) while holding
 * that many of the account's in-flight slots, released when it settles.
 * Wrap only the network round trip, not quota waits or retry sleeps.
 */
export async function withGmailInflightSlot<T>(
  {
    emailAccountId,
    priority,
    weight = 1,
  }: {
    emailAccountId: string | undefined;
    priority: Priority;
    weight?: number;
  },
  send: () => Promise<T>,
): Promise<T> {
  const held = heldSlots.getStore();
  if (!emailAccountId || held?.has(emailAccountId)) return send();

  const account = accounts.get(emailAccountId) ?? {
    inflight: 0,
    waiters: [],
  };
  accounts.set(emailAccountId, account);
  const permits = Math.min(Math.max(1, Math.ceil(weight)), CEILING[priority]);
  await acquire(emailAccountId, account, priority, permits);
  try {
    return await heldSlots.run(
      new Set([...(held ?? []), emailAccountId]),
      send,
    );
  } finally {
    account.inflight -= permits;
    grantWaiters(account);
    if (account.inflight <= 0 && account.waiters.length === 0)
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
) {
  const aheadOrEqual = account.waiters.some(
    (waiter) => RANK[waiter.priority] <= RANK[priority],
  );
  if (!aheadOrEqual && account.inflight + permits <= CEILING[priority]) {
    account.inflight += permits;
    return;
  }

  const startedAt = Date.now();
  const granted = await new Promise<boolean>((resolve) => {
    const waiter: Waiter = {
      priority,
      permits,
      grant: () => {
        clearTimeout(timer);
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      account.waiters.splice(account.waiters.indexOf(waiter), 1);
      account.inflight += permits;
      grantWaiters(account);
      resolve(false);
    }, GMAIL_INFLIGHT_MAX_WAIT_MS[priority]);
    // Higher priorities first, arrival order within one.
    const before = account.waiters.findIndex(
      (other) => RANK[other.priority] > RANK[priority],
    );
    account.waiters.splice(
      before === -1 ? account.waiters.length : before,
      0,
      waiter,
    );
  });

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
      inflight: account.inflight,
      waitedMs,
    });
  }
}

// Grants in queue order and stops at the first that does not fit, so a later,
// smaller call never overtakes a waiting person's call.
function grantWaiters(account: AccountSlots) {
  while (account.waiters.length > 0) {
    const next = account.waiters[0];
    if (account.inflight + next.permits > CEILING[next.priority]) return;
    account.waiters.shift();
    account.inflight += next.permits;
    next.grant();
  }
}
