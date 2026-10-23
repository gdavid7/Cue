import { recordVisitAction } from "@/utils/actions/away-summary";

// The server keeps the last visit to ten minutes too; asking more often
// changes nothing.
export const RECORD_VISIT_EVERY_MS = 10 * 60_000;
// Shared by this browser's tabs, so they record once between them; per user,
// so signing in as someone else records them straight away.
const STORAGE_KEY_PREFIX = "cue:visit-recorded-at:";

let inFlight: Promise<boolean> | null = null;
let recordedAt = 0;
const returnListeners = new Set<() => void>();

/**
 * Tells the server the user is here, at most every ten minutes across this
 * browser's tabs. Resolves once it has, with whether this was a return after
 * a break: Today's "While you were away" waits for it, so a return just now
 * already counts. Only a recorded visit starts the ten minutes; after a
 * failure the next input tries again.
 */
export function recordVisit({
  userId,
  now = Date.now(),
}: {
  /** Unknown while the user loads: the ten minutes are then this tab's. */
  userId?: string;
  now?: number;
} = {}): Promise<boolean> {
  if (inFlight) return inFlight;
  if (now - Math.max(recordedAt, readStored(userId)) < RECORD_VISIT_EVERY_MS)
    return Promise.resolve(false);
  inFlight = recordVisitAction()
    .then((result) => {
      if (!result?.data) return false;
      recordedAt = now;
      writeStored(userId, now);
      if (result.data.returned)
        for (const listener of returnListeners) listener();
      return result.data.returned;
    })
    .catch(() => false)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Called when a recorded visit was a return after a break. */
export function onVisitReturn(listener: () => void) {
  returnListeners.add(listener);
  return () => {
    returnListeners.delete(listener);
  };
}

export function resetRecordVisitForTesting() {
  inFlight = null;
  recordedAt = 0;
  returnListeners.clear();
}

function readStored(userId: string | undefined) {
  if (!userId) return 0;
  try {
    return Number(localStorage.getItem(STORAGE_KEY_PREFIX + userId)) || 0;
  } catch {
    return 0;
  }
}

function writeStored(userId: string | undefined, at: number) {
  if (!userId) return;
  try {
    localStorage.setItem(STORAGE_KEY_PREFIX + userId, String(at));
  } catch {
    // This tab still keeps its own ten minutes.
  }
}
