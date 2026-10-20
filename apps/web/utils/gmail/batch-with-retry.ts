import chunk from "lodash/chunk";
import { type BatchError, isBatchError, isDefined } from "@/utils/types";
import { getBatch } from "@/utils/gmail/batch";
import {
  getRetryTimeDelayMs,
  isGmailNotFound,
  isRetryableError,
  MAX_GMAIL_BLOCKING_RETRY_DELAY_MS,
} from "@/utils/gmail/retry";
import { sleep } from "@/utils/sleep";
import { timeRequestDependency } from "@/utils/request-metrics";
import type { Logger } from "@/utils/logger";
import {
  currentGmailQuotaContext,
  gmailRequestCost,
  gmailRequestUnitsFor,
  type GmailQuotaPriority,
} from "@/utils/gmail/quota";

// Gmail charges every request in a batch at once, so a batch is one burst.
// Each is sized to fit the gate's per-second pace at the caller's priority
// and the format it reads: 17 metadata reads or 5 full ones interactive, 12
// or 4 sync, 6 or 2 background.
const MAX_BATCH_RETRIES = 3;
const MAX_RETRY_JITTER_MS = 1000;

// Someone is waiting on an interactive read, so it gives up on a distant
// Retry-after rather than holding the request; background work can wait it out.
// The budget is the most one call sleeps in all, across chunks and rounds.
const RETRY_POLICY: Record<
  GmailQuotaPriority,
  { maxHintMs: number; sleepBudgetMs: number }
> = {
  interactive: { maxHintMs: 2500, sleepBudgetMs: 15_000 },
  sync: { maxHintMs: MAX_GMAIL_BLOCKING_RETRY_DELAY_MS, sleepBudgetMs: 60_000 },
  background: {
    maxHintMs: MAX_GMAIL_BLOCKING_RETRY_DELAY_MS,
    sleepBudgetMs: 120_000,
  },
};

type SleepBudget = { remainingMs: number };

export type BatchWithRetryResult<TParsed> = {
  items: TParsed[];
  /** Ids Gmail still refused once retries ran out; not attempted after that. */
  unloadedIds: string[];
  unloadedError?: BatchError["error"];
};

// Gmail counts each subrequest toward per-user concurrency. Leave headroom for
// other account activity, and halve the batch on each retry so a refused tail
// meets less concurrency the next time.
// Returns what loaded: once a batch runs out of retries the rest are left
// unloaded rather than retried, since they would meet the same limit. Callers
// that need every item use `requireCompleteBatch`.
export async function getBatchWithRetry<TRaw, TParsed>({
  ids,
  endpoint,
  accessToken,
  parse,
  logger,
  queryString,
  retryCount = 0,
  retryError,
}: {
  ids: string[];
  endpoint: string; // e.g. /gmail/v1/users/me/messages
  accessToken: string;
  parse: (item: TRaw) => TParsed;
  logger: Logger;
  queryString?: string;
  retryCount?: number;
  retryError?: BatchError["error"];
}): Promise<BatchWithRetryResult<TParsed>> {
  if (!accessToken) throw new Error("No access token");

  const sleepBudget: SleepBudget = {
    remainingMs:
      RETRY_POLICY[currentGmailQuotaContext().priority].sleepBudgetMs,
  };

  return getChunksWithRetry(
    chunk(ids, batchSizeFor(endpoint, queryString)),
    (idsChunk) =>
      getBatchChunkWithRetry<TRaw, TParsed>({
        ids: idsChunk,
        endpoint,
        accessToken,
        parse,
        logger,
        queryString,
        retryCount,
        retryError,
        sleepBudget,
      }),
  );
}

/** The items of a batch, or the error Gmail kept returning for the rest. */
export function requireCompleteBatch<TParsed>(
  result: BatchWithRetryResult<TParsed>,
): TParsed[] {
  if (!result.unloadedIds.length) return result.items;
  if (!result.unloadedError)
    throw new Error("Gmail batch retry limit exceeded");
  // Preserve the provider error so account-level rate-limit protection can pause follow-on calls.
  throw new Error(result.unloadedError.message, {
    cause: result.unloadedError,
  });
}

async function getBatchChunkWithRetry<TRaw, TParsed>({
  ids,
  endpoint,
  accessToken,
  parse,
  logger,
  queryString,
  retryCount,
  retryError,
  sleepBudget,
}: {
  ids: string[];
  endpoint: string;
  accessToken: string;
  parse: (item: TRaw) => TParsed;
  logger: Logger;
  queryString?: string;
  retryCount: number;
  retryError?: BatchError["error"];
  sleepBudget: SleepBudget;
}): Promise<BatchWithRetryResult<TParsed>> {
  if (retryCount > MAX_BATCH_RETRIES)
    return retryLimitReached({
      ids,
      retryCount,
      retryError,
      logger,
    });

  const batch: (TRaw | BatchError)[] = await getBatch(
    ids,
    endpoint,
    accessToken,
    queryString,
  );

  if (batch.some((item) => isBatchError(item) && item.error.code === 401)) {
    logger.error("Error fetching batch", { firstBatchItem: batch?.[0] });
    throw new Error("Invalid access token");
  }

  const missingIds = new Set<string>();
  let lastRetryableError = retryError;
  let retryableItemCount = 0;
  let rateLimitedItemCount = 0;
  let serverHintDelayMs = 0;
  let firstError: BatchError["error"] | undefined;

  const parsed = batch
    .map((item, i) => {
      if (isBatchError(item)) {
        const { code, message: errorMessage, errors } = item.error;
        const reason = errors?.[0]?.reason;

        const { retryable, isRateLimit } = isRetryableError({
          status: code,
          reason,
          errorMessage,
        });

        if (!retryable) {
          const fields = { code, reason, errorMessage };
          // Deleted since it was listed; callers handle the gap.
          if (isGmailNotFound({ status: code, reason }))
            logger.info(
              "Skipping batch item due to non-retryable error",
              fields,
            );
          else
            logger.warn(
              "Skipping batch item due to non-retryable error",
              fields,
            );
          return;
        }

        retryableItemCount++;
        firstError ??= item.error;
        if (isRateLimit) {
          rateLimitedItemCount++;
        }
        serverHintDelayMs = Math.max(
          serverHintDelayMs,
          getRetryTimeDelayMs(errorMessage) ?? 0,
        );
        if (isRateLimit || !lastRetryableError) {
          lastRetryableError = item.error;
        }
        missingIds.add(ids[i]);
        return;
      }

      return parse(item);
    })
    .filter(isDefined);

  if (missingIds.size > 0) {
    const remainingIds = Array.from(missingIds);
    const nextRetryCount = retryCount + 1;

    if (nextRetryCount > MAX_BATCH_RETRIES)
      return {
        ...retryLimitReached({
          ids: remainingIds,
          retryCount: nextRetryCount,
          retryError: lastRetryableError,
          logger,
        }),
        items: parsed,
      };

    const priority = currentGmailQuotaContext().priority;
    const { maxHintMs } = RETRY_POLICY[priority];
    const exponentialDelayMs = Math.min(
      1000 * 2 ** (nextRetryCount - 1),
      MAX_GMAIL_BLOCKING_RETRY_DELAY_MS,
    );
    const jitterMs = Math.floor(Math.random() * (MAX_RETRY_JITTER_MS + 1));
    // A time Gmail names is a floor, not a suggestion; retrying before it
    // only earns another refusal, so a read that cannot wait gives up instead.
    const delayMs =
      Math.max(exponentialDelayMs, Math.min(serverHintDelayMs, maxHintMs)) +
      jitterMs;
    if (
      (priority === "interactive" && serverHintDelayMs > maxHintMs) ||
      delayMs > sleepBudget.remainingMs
    )
      return {
        ...retryLimitReached({
          ids: remainingIds,
          retryCount: nextRetryCount,
          retryError: lastRetryableError,
          logger,
        }),
        items: parsed,
      };

    logger.warn("Retrying Gmail batch items", {
      batchSize: ids.length,
      retryableItemCount,
      rateLimitedItemCount,
      retryCount: nextRetryCount,
      firstCode: firstError?.code,
      firstReason: firstError?.errors?.[0]?.reason,
    });
    sleepBudget.remainingMs -= delayMs;
    await timeRequestDependency("wait", () => sleep(delayMs));
    const retryChunks = chunk(
      remainingIds,
      Math.max(
        1,
        Math.floor(batchSizeFor(endpoint, queryString) / 2 ** nextRetryCount),
      ),
    );
    const refetched = await getChunksWithRetry(retryChunks, (idsChunk) =>
      getBatchChunkWithRetry<TRaw, TParsed>({
        ids: idsChunk,
        endpoint,
        accessToken,
        parse,
        retryCount: nextRetryCount,
        retryError: lastRetryableError,
        logger,
        queryString,
        sleepBudget,
      }),
    );
    return { ...refetched, items: [...parsed, ...refetched.items] };
  }

  return { items: parsed, unloadedIds: [] };
}

async function getChunksWithRetry<TParsed>(
  chunks: string[][],
  getChunk: (ids: string[]) => Promise<BatchWithRetryResult<TParsed>>,
): Promise<BatchWithRetryResult<TParsed>> {
  const items: TParsed[] = [];
  for (const [index, idsChunk] of chunks.entries()) {
    const result = await getChunk(idsChunk);
    items.push(...result.items);
    if (result.unloadedIds.length)
      return {
        items,
        unloadedIds: [...result.unloadedIds, ...chunks.slice(index + 1).flat()],
        unloadedError: result.unloadedError,
      };
  }
  return { items, unloadedIds: [] };
}

function batchSizeFor(endpoint: string, queryString: string | undefined) {
  const maxUnits = gmailRequestUnitsFor(currentGmailQuotaContext().priority);
  const query = queryString ? `?${queryString}` : "";
  return Math.max(
    1,
    Math.floor(maxUnits / gmailRequestCost("GET", `${endpoint}/id${query}`)),
  );
}

function retryLimitReached<TParsed>({
  ids,
  retryCount,
  retryError,
  logger,
}: {
  ids: string[];
  retryCount: number;
  retryError?: BatchError["error"];
  logger: Logger;
}): BatchWithRetryResult<TParsed> {
  logger.warn("Too many Gmail batch retries", {
    batchSize: ids.length,
    retryCount,
  });
  return { items: [], unloadedIds: ids, unloadedError: retryError };
}
