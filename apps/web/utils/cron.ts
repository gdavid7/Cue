import { env } from "@/env";
import { secureCompare } from "@/utils/crypto-compare";
import { isValidInternalApiKey } from "@/utils/internal-api";
import type { Logger } from "@/utils/logger";
import type { RequestWithLogger } from "@/utils/middleware";

// Crons run with maxDuration 300; a run past this is close to being killed.
const CRON_RAN_LONG_MS = 240_000;

export function hasCronSecret(request: RequestWithLogger) {
  if (!env.CRON_SECRET) {
    request.logger.error("No cron secret set, unauthorized cron request");
    return false;
  }

  const valid = isValidCronSecret(request);

  if (!valid)
    request.logger.error("Unauthorized cron request", {
      hasAuthHeader: request.headers.has("authorization"),
    });

  return valid;
}

/**
 * For routes reached both by cron and by an internal queue forward. The cron
 * secret is checked quietly because a queue request only carries the internal
 * API key, and logging that as unauthorized before the key is even checked
 * floods the error logs.
 */
export function isAuthorizedCronOrInternalRequest(request: RequestWithLogger) {
  if (isValidCronSecret(request)) return true;
  return isValidInternalApiKey(request.headers, request.logger);
}

export async function hasPostCronSecret(request: RequestWithLogger) {
  if (!env.CRON_SECRET) {
    request.logger.error("No cron secret set, unauthorized cron request");
    return false;
  }

  // Clone the request before consuming the body
  const clonedRequest = request.clone();
  const body = await clonedRequest.json();
  const valid = secureCompare(body.CRON_SECRET, env.CRON_SECRET);

  if (!valid)
    request.logger.error("Unauthorized cron request", {
      hasCronSecret: typeof body?.CRON_SECRET === "string",
    });

  return valid;
}

/**
 * Runs a cron's work and logs one "Cron finished" line with its duration and
 * counts, so a run with nothing to do still leaves a daily heartbeat, or one
 * "Cron failed" line when it throws. The middleware scope on the logger names
 * the cron. The counts are spread into the line, so their keys must be fixed
 * names.
 */
export async function runCronJob<T extends Record<string, unknown>>({
  logger,
  run,
}: {
  logger: Logger;
  run: () => Promise<T>;
}): Promise<T> {
  const startedAt = Date.now();
  let durationMs = 0;
  try {
    const result = await run();
    durationMs = Date.now() - startedAt;
    logger.info("Cron finished", { durationMs, ...result });
    return result;
  } catch (error) {
    durationMs = Date.now() - startedAt;
    logger.error("Cron failed", { durationMs, error });
    throw error;
  } finally {
    if (durationMs > CRON_RAN_LONG_MS) {
      logger.warn("Cron ran long", {
        durationMs,
        thresholdMs: CRON_RAN_LONG_MS,
      });
    }
  }
}

export function getCronSecretHeader() {
  return new Headers({ authorization: `Bearer ${env.CRON_SECRET}` });
}

function isValidCronSecret(request: RequestWithLogger) {
  if (!env.CRON_SECRET) return false;
  return secureCompare(
    request.headers.get("authorization"),
    `Bearer ${env.CRON_SECRET}`,
  );
}
