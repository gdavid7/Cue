import type { UIMessageStreamWriter } from "ai";
import { z } from "zod";
import {
  type CountGroupBy,
  LOCAL_COUNT_LIMITS,
  LOCAL_SEARCH_LIMITS,
  type LocalCountSearch,
  type LocalMailSearchResult,
  localMailCountResultSchema,
} from "@/utils/actions/assistant-local-search.validation";
import type { Logger } from "@/utils/logger";
import type { AssistantSearchSyntax } from "@/utils/mail-engine/assistant-search";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { redis } from "@/utils/redis";
import { logRedisFailureOnce } from "@/utils/redis/unavailable-log";
import { sleep } from "@/utils/sleep";

// The browser answers in tens of milliseconds plus a round trip; past this a
// Gmail search is the faster way to an answer.
const LOCAL_SEARCH_WAIT_MS = 2500;
// A count reads every match, which takes the browser longer than a page;
// past this the provider's own listing is the faster exact answer. It stays
// inside the request key's lifetime.
const LOCAL_COUNT_WAIT_MS = 8000;
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

// Only which messages matched crosses Redis: their senders, subjects and
// snippets are read from the provider by the run that asked (RD-3). A count
// holds numbers, ids, and month, week or label-id keys.
const storedAnswerSchema = z.discriminatedUnion("status", [
  localMailCountResultSchema,
  z.object({
    status: z.literal("ok"),
    messages: z
      .array(
        z.object({
          id: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
          threadId: z.string().min(1).max(LOCAL_SEARCH_LIMITS.id),
        }),
      )
      .max(LOCAL_SEARCH_LIMITS.messages),
    nextPageToken: z.string().max(LOCAL_SEARCH_LIMITS.pageToken).optional(),
  }),
  z.object({ status: z.literal("unavailable"), reason: z.string() }),
]);

type StoredAnswer = z.infer<typeof storedAnswerSchema>;
export type LocalMailSearchAnswer = Extract<StoredAnswer, { status: "ok" }>;
export type LocalMailCountAnswer = Extract<StoredAnswer, { status: "counted" }>;

export type LocalMailSearch = {
  /**
   * Asks the browser running this chat to answer an inbox search from its
   * local mail store. Resolves with the ids it matched, or null when it can't
   * answer (or doesn't in time) and the caller should search the provider.
   */
  search(
    input: {
      query: string;
      limit: number;
      pageToken?: string;
    } & AssistantSearchSyntax,
  ): Promise<LocalMailSearchAnswer | null>;
  /**
   * Asks the browser to count everything each search matches in its local
   * mail store, grouped as asked. Resolves null when it can't count at all
   * (or doesn't in time); an account it can't count is listed unavailable.
   * Undefined for a browser that can't count.
   */
  count?(input: {
    searches: LocalCountSearch[];
    groupBy?: CountGroupBy;
  }): Promise<LocalMailCountAnswer | null>;
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
  canCount = false,
  waitMs = LOCAL_SEARCH_WAIT_MS,
  countWaitMs = LOCAL_COUNT_WAIT_MS,
  pollIntervalMs = POLL_INTERVAL_MS,
  abortSignal,
}: {
  emailAccountId: string;
  logger: Logger;
  /** The browser said it can count; older tabs only search. */
  canCount?: boolean;
  waitMs?: number;
  countWaitMs?: number;
  pollIntervalMs?: number;
  /** The turn's stop signal: a stopped turn stops waiting for the browser. */
  abortSignal?: AbortSignal;
}): LocalMailSearch & { attach(writer: UIMessageStreamWriter): void } {
  let writer: UIMessageStreamWriter | null = null;

  async function ask(
    send: (writer: UIMessageStreamWriter, requestId: string) => void,
    wait: number,
  ): Promise<StoredAnswer | null> {
    if (!writer) return null;
    const requestId = crypto.randomUUID();
    const key = resultKey(emailAccountId, requestId);
    const startedAt = Date.now();
    try {
      // Only a request this run opened can be answered.
      await redis.set(key, PENDING, { ex: PENDING_TTL_SECONDS });
    } catch (error) {
      logRedisFailureOnce(logger, "Could not open a local mail search", {
        error,
      });
      return null;
    }
    send(writer, requestId);

    // The browser usually answers within the first poll or two; past that,
    // reading Redis less often costs little.
    for (let poll = 0; Date.now() - startedAt < wait; poll++) {
      if (abortSignal?.aborted) break;
      await abortableSleep(
        pollIntervalMs * 2 ** Math.min(poll, MAX_BACKOFF_DOUBLINGS),
        abortSignal,
      );
      if (abortSignal?.aborted) break;
      let stored: unknown;
      try {
        stored = await redis.eval<string[], unknown>(
          takeScript,
          [key],
          [PENDING],
        );
      } catch (error) {
        // The answer can't arrive without Redis; search the provider now.
        logRedisFailureOnce(logger, "Could not read a local mail search", {
          error,
        });
        return null;
      }
      if (!stored || stored === PENDING) continue;
      const parsed = storedAnswerSchema.safeParse(parseStored(stored));
      const durationMs = Date.now() - startedAt;
      if (!parsed.success) {
        logger.warn("Local mail search answer was malformed", { durationMs });
        return null;
      }
      logger.info("Local mail search answered", {
        status: parsed.data.status,
        ...describeAnswer(parsed.data),
        durationMs,
      });
      return parsed.data;
    }

    redis.del(key).catch(() => undefined);
    logger.info(
      abortSignal?.aborted
        ? "Local mail search stopped with the turn"
        : "Local mail search timed out",
      { durationMs: Date.now() - startedAt },
    );
    return null;
  }

  return {
    attach(streamWriter) {
      writer = streamWriter;
    },
    async search(input) {
      const answer = await ask((streamWriter, requestId) => {
        streamWriter.write({
          type: "data-local-mail-search",
          data: { requestId, ...input },
          transient: true,
        });
      }, waitMs);
      return answer?.status === "ok" ? answer : null;
    },
    ...(canCount && {
      async count(input: {
        searches: LocalCountSearch[];
        groupBy?: CountGroupBy;
      }) {
        const searches = input.searches.slice(0, LOCAL_COUNT_LIMITS.accounts);
        const answer = await ask((streamWriter, requestId) => {
          streamWriter.write({
            type: "data-local-mail-count",
            data: { requestId, searches, groupBy: input.groupBy },
            transient: true,
          });
        }, countWaitMs);
        if (answer?.status !== "counted") return null;
        // Only the accounts this run asked about are counted.
        const asked = new Set(searches.map((search) => search.accountId));
        return {
          ...answer,
          accounts: answer.accounts.filter((item) => asked.has(item.accountId)),
          groups: answer.groups.filter((group) => asked.has(group.accountId)),
          newest: answer.newest.filter((item) => asked.has(item.accountId)),
        };
      },
    }),
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

/**
 * Stores which messages the browser matched, if its request is still open;
 * false if not. Ids only: nothing the messages say reaches Redis.
 */
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
    [PENDING, JSON.stringify(idsOnly(result))],
  );
  return Number(stored) === 1;
}

function describeAnswer(answer: StoredAnswer) {
  switch (answer.status) {
    case "unavailable":
      return { reason: answer.reason };
    case "ok":
      return { resultCount: answer.messages.length };
    case "counted":
      return {
        accountCount: answer.accounts.length,
        unavailableAccounts: answer.accounts.filter((item) => item.unavailable)
          .length,
      };
  }
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

function idsOnly(result: LocalMailSearchResult) {
  if (result.status === "counted")
    return localMailCountResultSchema.parse(result);
  if (result.status !== "ok") return result;
  return {
    status: result.status,
    messages: result.messages.map(({ id, threadId }) => ({ id, threadId })),
    ...(result.nextPageToken ? { nextPageToken: result.nextPageToken } : {}),
  };
}
