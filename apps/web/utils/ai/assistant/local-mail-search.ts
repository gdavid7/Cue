import type { UIMessageStreamWriter } from "ai";
import {
  type LocalMailSearchResult,
  localMailSearchResultSchema,
} from "@/utils/actions/assistant-local-search.validation";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { sleep } from "@/utils/sleep";

// The browser answers in tens of milliseconds plus a round trip; past this a
// Gmail search is the faster way to an answer.
const LOCAL_SEARCH_WAIT_MS = 2500;
const POLL_INTERVAL_MS = 50;
const RESULT_TTL_SECONDS = 60;

export type LocalMailSearchAnswer = Extract<
  LocalMailSearchResult,
  { status: "ok" }
>;

export type LocalMailSearch = {
  /**
   * Asks the browser running this chat to answer an inbox search from its
   * local mail store. Resolves with its answer, or null when it can't answer
   * (or doesn't in time) and the caller should search the provider.
   */
  search(input: {
    query: string;
    limit: number;
    pageToken?: string;
  }): Promise<LocalMailSearchAnswer | null>;
};

/**
 * The chat run's side of a local search: the request goes to the browser as
 * a transient part of the reply stream, and its answer comes back through
 * `saveLocalMailSearchResult` (a server action) into Redis, where this run,
 * possibly on another instance, picks it up. Nothing is asked until the
 * reply stream is attached.
 */
export function createLocalMailSearch({
  emailAccountId,
  logger,
  waitMs = LOCAL_SEARCH_WAIT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
}: {
  emailAccountId: string;
  logger: Logger;
  waitMs?: number;
  pollIntervalMs?: number;
}): LocalMailSearch & { attach(writer: UIMessageStreamWriter): void } {
  let writer: UIMessageStreamWriter | null = null;

  return {
    attach(streamWriter) {
      writer = streamWriter;
    },
    async search(input) {
      if (!writer) return null;
      const requestId = crypto.randomUUID();
      const key = resultKey(emailAccountId, requestId);
      const startedAt = Date.now();
      writer.write({
        type: "data-local-mail-search",
        data: { requestId, ...input },
        transient: true,
      });

      while (Date.now() - startedAt < waitMs) {
        await sleep(pollIntervalMs);
        const stored = await redis.get<unknown>(key).catch(() => null);
        if (!stored) continue;
        redis.del(key).catch(() => undefined);
        const parsed = localMailSearchResultSchema.safeParse(stored);
        const durationMs = Date.now() - startedAt;
        if (!parsed.success) {
          logger.warn("Local mail search answer was malformed", { durationMs });
          return null;
        }
        logger.info("Local mail search answered", {
          status: parsed.data.status,
          ...(parsed.data.status === "unavailable"
            ? { reason: parsed.data.reason }
            : { resultCount: parsed.data.messages.length }),
          durationMs,
        });
        return parsed.data.status === "ok" ? parsed.data : null;
      }

      logger.info("Local mail search timed out", { durationMs: waitMs });
      return null;
    },
  };
}

export async function saveLocalMailSearchResult({
  emailAccountId,
  requestId,
  result,
}: {
  emailAccountId: string;
  requestId: string;
  result: LocalMailSearchResult;
}) {
  await redis.set(resultKey(emailAccountId, requestId), result, {
    ex: RESULT_TTL_SECONDS,
  });
}

// The request id is random and only sent to this account's chat, so the key
// can't be answered for another account or run.
function resultKey(emailAccountId: string, requestId: string) {
  return `assistant-local-search:${emailAccountId}:${requestId}`;
}
