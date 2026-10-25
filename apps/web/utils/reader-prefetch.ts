import { type Key, unstable_serialize } from "swr";
import { createClientLogger } from "@/utils/logger-client";

/**
 * Starts Cue's brief of a row the user is about to open, so it is on its way
 * before the click. The request is the one the reader would make; it only
 * starts sooner, and the reader takes it over by its SWR key.
 *
 * Each brief is a model call, so it is kept cheap on purpose: only a pointer
 * resting on a row for `delayMs` counts as intent, a newer intent replaces a
 * pending one, leaving the row cancels it, an account with a prefetch in
 * flight starts no other, and an account starts at most `perMinute` a minute,
 * so sweeping down the list can't fire one per row. One the reader never took
 * is reported as unused, so its cost is measured.
 */
type PrefetchOutcome = "used" | "unused" | "failed";

type PrefetchRequest = {
  /** The reader's SWR key for the same request. */
  key: Key;
  run: () => Promise<unknown>;
};

type PrefetchIntent = {
  accountId: string;
  threadId: string;
  /** Read when the delay is up, so it sees what the browser holds by then. */
  request: () => PrefetchRequest | null;
};

type Entry = {
  accountId: string;
  startedAt: number;
  status: "pending" | "ok" | "error";
  promise: Promise<unknown>;
};

export const PREFETCH_INTENT_DELAY_MS = 300;
// Long enough for a hover that turns into an open a little later.
const PREFETCH_TTL_MS = 5 * 60 * 1000;
const PREFETCHES_PER_MINUTE = 6;
const MINUTE_MS = 60 * 1000;

export function createReaderPrefetcher({
  delayMs = PREFETCH_INTENT_DELAY_MS,
  ttlMs = PREFETCH_TTL_MS,
  perMinute = PREFETCHES_PER_MINUTE,
  now = Date.now,
  report,
}: {
  delayMs?: number;
  ttlMs?: number;
  perMinute?: number;
  now?: () => number;
  report: (outcome: PrefetchOutcome) => void;
}) {
  const entries = new Map<string, Entry>();
  const startsByAccount = new Map<string, number[]>();
  let pending: {
    accountId: string;
    threadId: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  const sweep = () => {
    const at = now();
    for (const [key, entry] of entries) {
      if (entry.status === "pending" || at - entry.startedAt < ttlMs) continue;
      entries.delete(key);
      report(entry.status === "error" ? "failed" : "unused");
    }
  };

  const withinBudget = (accountId: string) => {
    const at = now();
    const recent = (startsByAccount.get(accountId) ?? []).filter(
      (startedAt) => at - startedAt < MINUTE_MS,
    );
    startsByAccount.set(accountId, recent);
    return recent.length < perMinute;
  };

  const start = ({ accountId, request: getRequest }: PrefetchIntent) => {
    sweep();
    const inFlight = [...entries.values()].some(
      (entry) => entry.accountId === accountId && entry.status === "pending",
    );
    if (inFlight || !withinBudget(accountId)) return;
    const request = getRequest();
    if (!request) return;
    const key = unstable_serialize(request.key);
    if (entries.has(key)) return;
    startsByAccount.get(accountId)?.push(now());
    const entry: Entry = {
      accountId,
      startedAt: now(),
      status: "pending",
      promise: Promise.resolve(),
    };
    entry.promise = request.run().then(
      (value) => {
        entry.status = "ok";
        entry.startedAt = now();
        return value;
      },
      (error: unknown) => {
        entry.status = "error";
        entry.startedAt = now();
        throw error;
      },
    );
    // Rejections surface to the reader if it takes the request.
    entry.promise.catch(() => undefined);
    entries.set(key, entry);
  };

  /** Whatever intent is waiting on its delay is dropped. */
  const cancelPending = () => {
    if (!pending) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  return {
    cancelPending,
    /** The pointer left the row, or pressed it: its reader asks for itself. */
    cancel(threadId: string) {
      if (pending?.threadId === threadId) cancelPending();
    },
    /** The pointer came to rest on a row. */
    intend(intent: PrefetchIntent) {
      if (
        pending?.accountId === intent.accountId &&
        pending.threadId === intent.threadId
      )
        return;
      cancelPending();
      pending = {
        accountId: intent.accountId,
        threadId: intent.threadId,
        timer: setTimeout(() => {
          pending = null;
          start(intent);
        }, delayMs),
      };
    },
    /**
     * The prefetched request for the reader's key, once. A failed one is
     * dropped so the reader asks again rather than showing an old error.
     */
    take(key: Key): Promise<unknown> | undefined {
      sweep();
      const serialized = unstable_serialize(key);
      const entry = entries.get(serialized);
      if (!entry) return;
      entries.delete(serialized);
      if (entry.status === "error") {
        report("failed");
        return;
      }
      report("used");
      return entry.promise;
    },
    /** The page is going away: whatever is left was never shown. */
    flush() {
      for (const entry of entries.values())
        report(entry.status === "error" ? "failed" : "unused");
      entries.clear();
      cancelPending();
    },
  };
}

let shared: ReturnType<typeof createReaderPrefetcher> | undefined;

export function getReaderPrefetcher() {
  if (shared) return shared;
  const logger = createClientLogger("reader-prefetch");
  const prefetcher = createReaderPrefetcher({
    report: (outcome) =>
      logger.info("Reader prefetch settled", { kind: "brief", outcome }),
  });
  if (typeof window !== "undefined")
    window.addEventListener("pagehide", () => prefetcher.flush());
  shared = prefetcher;
  return prefetcher;
}

/** The reader's fetch: a prefetched request for this key, or a new one. */
export function takeReaderPrefetchOr<T>(
  key: Key,
  fetch: () => Promise<T>,
): Promise<T> {
  return (getReaderPrefetcher().take(key) as Promise<T> | undefined) ?? fetch();
}
