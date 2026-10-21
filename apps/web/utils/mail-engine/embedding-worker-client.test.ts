import { describe, expect, it, vi } from "vitest";
import { createWorkerTextEmbedder } from "@/utils/mail-engine/embedding-worker-client";
import type { EmbeddingWorkerRequest } from "@/utils/mail-engine/embedding-worker-protocol";

describe("createWorkerTextEmbedder", () => {
  it("starts the model's worker on the first request and stops it once idle", async () => {
    vi.useFakeTimers();
    try {
      const workers: FakeWorker[] = [];
      const embedder = createWorkerTextEmbedder(() => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker as unknown as Worker;
      });
      expect(workers).toHaveLength(0);

      const vectors = await embedder.embed(["kitchen"]);
      expect(vectors).toEqual([Float32Array.from([7])]);
      expect(workers).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(61_000);
      expect(workers[0].terminated).toBe(true);
      await embedder.embed(["again"]);
      expect(workers).toHaveLength(2);
      embedder.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a request the worker couldn't answer, and still answers the next", async () => {
    const embedder = createWorkerTextEmbedder(
      () => new FakeWorker(1) as unknown as Worker,
    );
    await expect(embedder.embed(["kitchen"])).rejects.toThrow(
      "model_download_503",
    );
    await expect(embedder.embed(["kitchen"])).resolves.toHaveLength(1);
    embedder.close();
  });
});

// Answers each text with its length, after failing its first `failures`
// requests like a model that couldn't download.
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  private failures: number;
  constructor(failures = 0) {
    this.failures = failures;
  }
  postMessage({ id, texts }: EmbeddingWorkerRequest) {
    const failing = this.failures > 0;
    this.failures -= 1;
    queueMicrotask(() =>
      this.onmessage?.({
        data: failing
          ? { id, error: "model_download_503" }
          : {
              id,
              vectors: texts.map((text) => Float32Array.from([text.length])),
            },
      } as MessageEvent),
    );
  }
  terminate() {
    this.terminated = true;
  }
}
