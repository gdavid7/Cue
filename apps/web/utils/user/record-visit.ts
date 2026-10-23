import { recordVisitAction } from "@/utils/actions/away-summary";

// The server keeps the last visit to ten minutes too; asking more often
// changes nothing.
export const RECORD_VISIT_EVERY_MS = 10 * 60_000;
// Shared by this browser's tabs, so they record once between them.
const STORAGE_KEY = "cue:visit-recorded-at";

let inFlight: Promise<unknown> | null = null;
let recordedAt = 0;

/**
 * Tells the server the user is here, at most every ten minutes across this
 * browser's tabs. Resolves once it has: Today's "While you were away" waits
 * for it, so a return is recorded before the card is asked for.
 */
export function recordVisit(now = Date.now()): Promise<unknown> {
  if (inFlight) return inFlight;
  if (now - Math.max(recordedAt, readStored()) < RECORD_VISIT_EVERY_MS)
    return Promise.resolve();
  recordedAt = now;
  writeStored(now);
  inFlight = recordVisitAction()
    .catch(() => undefined)
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function resetRecordVisitForTesting() {
  inFlight = null;
  recordedAt = 0;
}

function readStored() {
  try {
    return Number(localStorage.getItem(STORAGE_KEY)) || 0;
  } catch {
    return 0;
  }
}

function writeStored(at: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(at));
  } catch {
    // This tab still records on its own.
  }
}
