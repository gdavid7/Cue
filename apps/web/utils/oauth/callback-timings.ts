import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";

type CallbackTimings = {
  startedAt: number;
  steps: Record<string, number>;
  deferred: string[];
  logged: boolean;
};

const timingsStorage = new AsyncLocalStorage<CallbackTimings>();

/**
 * Runs an OAuth callback someone is waiting on and logs one "Sign-in callback
 * timings" line: how long the redirect took and which steps held it up.
 * Step names without a "." are top-level; whatever they don't cover (token
 * exchange, better-auth's own reads and writes) is `untrackedMs`.
 */
export async function runWithCallbackTimings<T>(
  {
    flow,
    provider,
    logger,
  }: { flow: "sign-in" | "link"; provider: string; logger: Logger },
  operation: () => Promise<T>,
): Promise<T> {
  const timings: CallbackTimings = {
    startedAt: performance.now(),
    steps: {},
    deferred: [],
    logged: false,
  };
  let status: number | "threw" = "threw";
  try {
    const result = await timingsStorage.run(timings, operation);
    status = result instanceof Response ? result.status : 200;
    return result;
  } finally {
    // Deferred work shares this store; it runs after the line is written.
    timings.logged = true;
    const totalMs = elapsedMs(timings.startedAt);
    const trackedMs = Object.entries(timings.steps)
      .filter(([name]) => !name.includes("."))
      .reduce((sum, [, ms]) => sum + ms, 0);
    logger.info("Sign-in callback timings", {
      flow,
      provider,
      status,
      totalMs,
      untrackedMs: Math.max(0, totalMs - trackedMs),
      steps: timings.steps,
      deferred: timings.deferred,
    });
  }
}

/** Times a step the callback waits on. Outside a timed callback it just runs. */
export async function timeCallbackStep<T>(
  name: string,
  step: () => Promise<T>,
): Promise<T> {
  const timings = timingsStorage.getStore();
  if (!timings || timings.logged) return step();
  const startedAt = performance.now();
  try {
    return await step();
  } finally {
    timings.steps[name] = (timings.steps[name] ?? 0) + elapsedMs(startedAt);
  }
}

/** Records how long the callback ran before reaching this point. */
export function markCallbackStep(name: string) {
  const timings = timingsStorage.getStore();
  if (!timings || timings.logged) return;
  timings.steps[name] = elapsedMs(timings.startedAt);
}

/**
 * Runs work the first page doesn't need once the callback has responded, so
 * the person isn't kept waiting on it. Failures are logged, never thrown: they
 * can't fail a sign-in that has already redirected.
 */
export function deferCallbackStep(
  name: string,
  step: () => Promise<unknown>,
  logger: Logger,
) {
  timingsStorage.getStore()?.deferred.push(name);
  after(async () => {
    const startedAt = performance.now();
    try {
      await step();
      logger.info("Deferred sign-in step finished", {
        step: name,
        ms: elapsedMs(startedAt),
      });
    } catch (error) {
      logger.error("Deferred sign-in step failed", {
        step: name,
        ms: elapsedMs(startedAt),
        error,
      });
      captureException(error, { extra: { step: name } });
    }
  });
}

function elapsedMs(startedAt: number) {
  return Math.round(performance.now() - startedAt);
}
