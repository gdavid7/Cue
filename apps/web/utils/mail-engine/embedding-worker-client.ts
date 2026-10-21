import type { TextEmbedder } from "@/utils/mail-search/semantic-embedding";

/**
 * The model couldn't be kept on this device, as when storage is full: it
 * would download again on every pass, so semantic search stops for the
 * session.
 */
export const MODEL_NOT_CACHED = "model_not_cached";

export type EmbeddingWorkerRequest = { id: number; texts: string[] };
export type EmbeddingWorkerResponse =
  | { id: number; vectors: Float32Array[] }
  | { id: number; error: string };

// The model holds about a hundred megabytes while loaded; it goes once the
// index and search have left it idle this long.
const IDLE_MS = 60_000;

/**
 * Embeds text in a worker of its own, started on the first request and
 * stopped when idle, so nothing of the model loads until search or the
 * background index needs it.
 */
export function createWorkerTextEmbedder(
  createWorker: () => Worker = () =>
    new Worker(new URL("./embedding-worker.ts", import.meta.url), {
      type: "module",
    }),
): TextEmbedder & { close(): void } {
  let worker: Worker | null = null;
  let nextId = 0;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<
    number,
    {
      resolve: (vectors: Float32Array[]) => void;
      reject: (error: Error) => void;
    }
  >();

  function stop() {
    clearTimeout(idleTimer);
    worker?.terminate();
    worker = null;
    for (const request of pending.values())
      request.reject(new Error("embedding_worker_stopped"));
    pending.clear();
  }

  function start() {
    const started = createWorker();
    started.onmessage = (event: MessageEvent<EmbeddingWorkerResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      if ("error" in event.data) request.reject(new Error(event.data.error));
      else request.resolve(event.data.vectors);
      if (!pending.size) idleTimer = setTimeout(stop, IDLE_MS);
    };
    started.onerror = (event) => {
      event.preventDefault();
      stop();
    };
    return started;
  }

  return {
    embed(texts) {
      if (!texts.length) return Promise.resolve([]);
      clearTimeout(idleTimer);
      worker ??= start();
      const id = nextId++;
      const target = worker;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        target.postMessage({ id, texts } satisfies EmbeddingWorkerRequest);
      });
    },
    close: stop,
  };
}
