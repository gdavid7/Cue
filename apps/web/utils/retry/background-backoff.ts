// Background jobs that keep failing back off so a frequent cron doesn't retry
// them at every tick, and stop after about a day of tries.
export const MAX_RETRY_ATTEMPTS = 10;
const FIRST_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 6 * 60 * 60 * 1000;

export function getRetryDelayMs(failedAttempts: number) {
  return Math.min(
    FIRST_RETRY_DELAY_MS * 2 ** Math.max(failedAttempts - 1, 0),
    MAX_RETRY_DELAY_MS,
  );
}
