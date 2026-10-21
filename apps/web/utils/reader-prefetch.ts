import { type Key, unstable_serialize } from "swr";
import { createClientLogger } from "@/utils/logger-client";

/**
 * Starts the reader's slow requests (Cue's brief, related context) for a row
 * the user is about to open, so they are on their way before the click.
 * Every request is the same one the reader would make; it only starts sooner,
 * and the reader takes it over by its SWR key.
 *
 * Kept cheap on purpose: the brief is a model call and context spends the
 * account's Gmail quota. Only a pointer resting on a row for `delayMs` counts
 * as intent, a newer intent replaces a pending one, leaving the row cancels
 * it, and an account with a prefetch still in flight starts no other. One the
 * reader never took is reported as unused, so its cost is measured.
 */
export type PrefetchKind = "brief" | "context";
type PrefetchOutcome = "used" | "unused" | "failed";

type PrefetchRequest = {
  kind: PrefetchKind;
  /** The reader's SWR key for the same request. */
  key: Key;
  run: () => Promise<unknown>;
};

type PrefetchIntent = {
  accountId: string;
  threadId: string;
  /** Read when the delay is up, so it sees what the browser holds by then. */
  requests: () => PrefetchRequest[];
};

type Entry = {
  kind: PrefetchKind;
  accountId: string;
  startedAt: number;
  status: "pending" | "ok" | "error";
  promise: Promise<unknown>;
};

export const PREFETCH_INTENT_DELAY_MS = 300;
// Long enough for a hover that turns into an open a little later; short
// enough that related items aren't stale when it does.
export const PREFETCH_TTL_MS = 5 * 60 * 1000;

export function createReaderPrefetcher({
  delayMs = PREFETCH_INTENT_DELAY_MS,
  ttlMs = PREFETCH_TTL_MS,
  now = Date.now,
  report,
}: {
  delayMs?: number;
  ttlMs?: number;
  now?: () => number;
  report: (kind: PrefetchKind, outcome: PrefetchOutcome) => void;
}) {
  const entries = new Map<string, Entry>();
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
      report(entry.kind, entry.status === "error" ? "failed" : "unused");
    }
  };

  const start = ({ accountId, requests }: PrefetchIntent) => {
    sweep();
    const inFlight = [...entries.values()].some(
      (entry) => entry.accountId === accountId && entry.status === "pending",
    );
    if (inFlight) return;
    for (const request of requests()) {
      const key = unstable_serialize(request.key);
      if (entries.has(key)) continue;
      const entry: Entry = {
        kind: request.kind,
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
    }
  };

  /**
   * The pointer left, or the row is being opened: its reader asks for itself.
   * Without a thread, cancels whatever is pending.
   */
  const cancel = (threadId?: string) => {
    if (!pending || (threadId && pending.threadId !== threadId)) return;
    clearTimeout(pending.timer);
    pending = null;
  };

  return {
    cancel,
    /** The pointer came to rest on a row. */
    intend(intent: PrefetchIntent) {
      if (
        pending?.accountId === intent.accountId &&
        pending.threadId === intent.threadId
      )
        return;
      cancel();
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
        report(entry.kind, "failed");
        return;
      }
      report(entry.kind, "used");
      return entry.promise;
    },
    /** The page is going away: whatever is left was never shown. */
    flush() {
      for (const entry of entries.values())
        report(entry.kind, entry.status === "error" ? "failed" : "unused");
      entries.clear();
      cancel();
    },
  };
}

let shared: ReturnType<typeof createReaderPrefetcher> | undefined;

export function getReaderPrefetcher() {
  if (shared) return shared;
  const logger = createClientLogger("reader-prefetch");
  const prefetcher = createReaderPrefetcher({
    report: (kind, outcome) =>
      logger.info("Reader prefetch settled", { kind, outcome }),
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
