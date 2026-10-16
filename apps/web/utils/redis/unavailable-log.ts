import type { Logger } from "@/utils/logger";

const QUIET_PERIOD_MS = 10 * 60_000;

const lastLogged = new Map<string, { at: number; suppressed: number }>();

/**
 * For best-effort Redis work that degrades safely: when Redis refuses (an
 * outage, or the plan's command limit), every call fails the same way, so
 * each instance logs a message once per quiet period, with how many it held
 * back, instead of once per call.
 */
export function logRedisFailureOnce(
  logger: Pick<Logger, "warn">,
  message: string,
  fields: Record<string, unknown>,
) {
  const now = Date.now();
  const previous = lastLogged.get(message);
  if (previous && now - previous.at < QUIET_PERIOD_MS) {
    previous.suppressed += 1;
    return;
  }
  lastLogged.set(message, { at: now, suppressed: 0 });
  logger.warn(message, {
    ...fields,
    suppressedSinceLastLog: previous?.suppressed ?? 0,
  });
}
