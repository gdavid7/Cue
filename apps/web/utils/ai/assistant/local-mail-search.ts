import type { UIMessageStreamWriter } from "ai";
import {
  type LocalMailSearchResult,
  localMailSearchResultSchema,
} from "@/utils/actions/assistant-local-search.validation";
import type { Logger } from "@/utils/logger";
import type { AssistantSearchSyntax } from "@/utils/mail-engine/assistant-search";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { redis } from "@/utils/redis";
import { sleep } from "@/utils/sleep";

// The browser answers in tens of milliseconds plus a round trip; past this a
// Gmail search is the faster way to an answer.
const LOCAL_SEARCH_WAIT_MS = 2500;
const POLL_INTERVAL_MS = 50;
// 50, 100, then every 200 ms.
const MAX_BACKOFF_DOUBLINGS = 2;
// A request is open for answers this long; the key then expires on its own.
const PENDING_TTL_SECONDS = 10;
const PENDING = "pending";
// Six steps of a few searches each, across a person's tabs and turns.
const ANSWERS_PER_MINUTE = 60;

// Stores an answer only over this run's open request, once.
const answerScript = `-- answer
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'KEEPTTL')
return 1
`;

// Returns the key's value and deletes it once it holds an answer.
const takeScript = `-- take
local value = redis.call('GET', KEYS[1])
if value and value ~= ARGV[1] then redis.call('DEL', KEYS[1]) end
return value
`;

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
  search(
    input: {
      query: string;
      limit: number;
      pageToken?: string;
    } & AssistantSearchSyntax,
  ): Promise<LocalMailSearchAnswer | null>;
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
  abortSignal,
}: {
  emailAccountId: string;
  logger: Logger;
  waitMs?: number;
  pollIntervalMs?: number;
  /** The turn's stop signal: a stopped turn stops waiting for the browser. */
  abortSignal?: AbortSignal;
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
      try {
        // Only a request this run opened can be answered.
        await redis.set(key, PENDING, { ex: PENDING_TTL_SECONDS });
      } catch (error) {
        logger.warn("Could not open a local mail search", { error });
        return null;
      }
      writer.write({
        type: "data-local-mail-search",
        data: { requestId, ...input },
        transient: true,
      });

      // The browser usually answers within the first poll or two; past that,
      // reading Redis less often costs little.
      for (let poll = 0; Date.now() - startedAt < waitMs; poll++) {
        if (abortSignal?.aborted) break;
        await abortableSleep(
          pollIntervalMs * 2 ** Math.min(poll, MAX_BACKOFF_DOUBLINGS),
          abortSignal,
        );
        if (abortSignal?.aborted) break;
        const stored = await redis
          .eval<string[], unknown>(takeScript, [key], [PENDING])
          .catch(() => null);
        if (!stored || stored === PENDING) continue;
        const parsed = localMailSearchResultSchema.safeParse(
          parseStored(stored),
        );
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

      redis.del(key).catch(() => undefined);
      logger.info(
        abortSignal?.aborted
          ? "Local mail search stopped with the turn"
          : "Local mail search timed out",
        { durationMs: Date.now() - startedAt },
      );
      return null;
    },
  };
}

/**
 * The server action's side: a browser answers at most a few searches per
 * assistant turn, so a steady stream of answers is turned away.
 */
export async function acceptLocalMailSearchResult({
  userId,
  emailAccountId,
  requestId,
  result,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  requestId: string;
  result: LocalMailSearchResult;
  logger?: Logger;
}) {
  await assertWithinUserRateLimit({
    scope: "assistant-local-search",
    userId,
    limit: ANSWERS_PER_MINUTE,
    windowSeconds: 60,
    logger,
  });
  return saveLocalMailSearchResult({ emailAccountId, requestId, result });
}

/** Stores the browser's answer if its request is still open; false if not. */
export async function saveLocalMailSearchResult({
  emailAccountId,
  requestId,
  result,
}: {
  emailAccountId: string;
  requestId: string;
  result: LocalMailSearchResult;
}): Promise<boolean> {
  const stored = await redis.eval<string[], number>(
    answerScript,
    [resultKey(emailAccountId, requestId)],
    [PENDING, JSON.stringify(result)],
  );
  return Number(stored) === 1;
}

function abortableSleep(ms: number, signal: AbortSignal | undefined) {
  if (!signal) return sleep(ms);
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

// The client returns JSON as a string, or already parsed.
function parseStored(stored: unknown): unknown {
  if (typeof stored !== "string") return stored;
  try {
    return JSON.parse(stored);
  } catch {
    return null;
  }
}

// The request id is random and only sent to this account's chat, so the key
// can't be answered for another account or run.
function resultKey(emailAccountId: string, requestId: string) {
  return `assistant-local-search:${emailAccountId}:${requestId}`;
}
