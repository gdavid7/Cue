import type {
  SemanticMatch,
  SemanticSearchQuery,
} from "@inboxzero/mail-core/queries";
import type {
  EmbeddingBacklogCursor,
  MailStore,
} from "@inboxzero/mail-core/ports/mail-store";
import { MODEL_NOT_CACHED } from "@/utils/mail-engine/embedding-worker-protocol";
import {
  messageEmbeddingText,
  quantizeVector,
  SEMANTIC_MODEL,
  type TextEmbedder,
} from "@/utils/mail-search/semantic-embedding";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * The mail semantic search covers: the last year, and no more than the
 * newest 5,000 messages of it (about 2 MB of vectors). Brute force over that
 * many is a few milliseconds, and the index builds in minutes.
 */
export const SEMANTIC_INDEX_CAP = {
  windowMs: 365 * DAY_MS,
  maxMessages: 5000,
};
/** Waits this long after the engine starts, so first load never shares the CPU. */
export const SEMANTIC_INDEX_START_DELAY_MS = 60_000;
// Small batches with a rest between keep the index a background task.
const BATCH_SIZE = 8;
const BATCH_REST_MS = 250;
/** Looks for new mail to embed this often once the backlog is done. */
export const SEMANTIC_INDEX_RECHECK_MS = 10 * 60_000;
// After a failed pass, waits this long, doubling with each failure in a row.
const RETRY_BASE_MS = 10 * 60_000;
const RETRY_MAX_MS = 8 * 60 * 60_000;
// Test settings never make the index spin.
const MIN_INTERVAL_MS = 1000;
/**
 * Below this, the model rarely means the mail matches what was searched. It
 * only keeps clear noise out; ranking decides how much the rest counts.
 */
export const SEMANTIC_MIN_SIMILARITY = 0.25;

/**
 * Builds and searches this device's vectors of recent mail. The index runs
 * in the background after a delay, or from the first search if sooner, and
 * stops for the session if the model can't be kept on this device.
 */
export function createSemanticIndex({
  store,
  embedder,
  nowMs = Date.now,
  startDelayMs = SEMANTIC_INDEX_START_DELAY_MS,
  recheckMs = SEMANTIC_INDEX_RECHECK_MS,
  sleep = defaultSleep,
}: {
  store: Pick<
    MailStore,
    | "readEmbeddingBacklog"
    | "writeMessageEmbeddings"
    | "pruneMessageEmbeddings"
    | "countMessageEmbeddings"
    | "readSemanticMatches"
  >;
  embedder: TextEmbedder;
  nowMs?: () => number;
  startDelayMs?: number;
  recheckMs?: number;
  sleep?: (ms: number) => Promise<void>;
}) {
  let stopped = false;
  let started = false;
  // Set only during the start delay, the one rest a search cuts short.
  let wake: (() => void) | null = null;
  recheckMs = Math.max(MIN_INTERVAL_MS, recheckMs);

  /** Embeds every message within the cap that lacks a vector; resolves how many. */
  async function indexBacklog() {
    const { sinceMs } = await store.pruneMessageEmbeddings({
      model: SEMANTIC_MODEL.id,
      sinceMs: nowMs() - SEMANTIC_INDEX_CAP.windowMs,
      maxMessages: SEMANTIC_INDEX_CAP.maxMessages,
    });
    let embedded = 0;
    // Each batch continues below the last, so a pass reads each message once.
    let before: EmbeddingBacklogCursor | null = null;
    while (!stopped) {
      const sources = await store.readEmbeddingBacklog({
        model: SEMANTIC_MODEL.id,
        sinceMs,
        limit: BATCH_SIZE,
        before,
      });
      const last = sources.at(-1);
      if (!last) break;
      before = { receivedAtMs: last.receivedAtMs, key: last.key };
      const vectors = await embedder.embed(sources.map(messageEmbeddingText));
      if (stopped) break;
      await store.writeMessageEmbeddings({
        model: SEMANTIC_MODEL.id,
        embeddings: sources.map((source, index) => ({
          key: source.key,
          receivedAtMs: source.receivedAtMs,
          fromBody: source.fromBody,
          vector: quantizeVector(vectors[index]),
        })),
      });
      embedded += sources.length;
      await sleep(BATCH_REST_MS);
    }
    return embedded;
  }

  async function run() {
    await Promise.race([
      sleep(startDelayMs),
      new Promise<void>((resolve) => {
        wake = resolve;
      }),
    ]);
    wake = null;
    let failures = 0;
    while (!stopped) {
      try {
        await indexBacklog();
        failures = 0;
      } catch (error) {
        if (isFatal(error)) {
          stopped = true;
          return;
        }
        failures += 1;
      }
      if (stopped) return;
      await sleep(
        failures
          ? Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (failures - 1))
          : recheckMs,
      );
    }
  }

  return {
    indexBacklog,
    start() {
      if (started) return;
      started = true;
      run().catch(() => undefined);
    },
    stop() {
      stopped = true;
      wake?.();
    },
    async search(query: SemanticSearchQuery): Promise<SemanticMatch[]> {
      // A search during the start delay starts the index now.
      wake?.();
      const text = query.text.trim();
      // Stopped for good, as when the model can't be kept on this device.
      if (!text || stopped) return [];
      const count = await store.countMessageEmbeddings({
        accountId: query.accountId,
        model: SEMANTIC_MODEL.id,
      });
      if (!count) return [];
      const [vector] = await embedder.embed([text]).catch((error) => {
        if (isFatal(error)) stopped = true;
        throw error;
      });
      return store.readSemanticMatches({
        accountId: query.accountId,
        model: SEMANTIC_MODEL.id,
        vector: quantizeVector(vector),
        limit: query.limit,
        minSimilarity: SEMANTIC_MIN_SIMILARITY,
      });
    },
  };
}

/**
 * Whether this device runs the model: a desktop-class browser with the
 * memory and cores for it, not on a metered or data-saving connection.
 * Phones skip it: the model is a one-time download of about 26 MB, and
 * embedding thousands of messages costs their battery.
 */
export function semanticSearchSupported(
  nav: Pick<Navigator, "userAgent" | "hardwareConcurrency"> & {
    userAgentData?: { mobile?: boolean };
    deviceMemory?: number;
    connection?: { saveData?: boolean };
  },
  page: { touchOnly?: boolean } = {},
) {
  if (page.touchOnly) return false;
  if (typeof WebAssembly === "undefined" || typeof caches === "undefined")
    return false;
  if (typeof Worker === "undefined") return false;
  if (nav.userAgentData?.mobile) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return false;
  if ((nav.hardwareConcurrency ?? 0) < 4) return false;
  if (nav.deviceMemory !== undefined && nav.deviceMemory < 4) return false;
  if (nav.connection?.saveData) return false;
  return true;
}

function isFatal(error: unknown) {
  return error instanceof Error && error.message === MODEL_NOT_CACHED;
}

function defaultSleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
