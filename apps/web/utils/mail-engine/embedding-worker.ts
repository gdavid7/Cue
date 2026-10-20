import * as ort from "onnxruntime-web/wasm";
import {
  SEMANTIC_MODEL,
  type SemanticModelFile,
  semanticModelFileUrl,
  type TextEmbedder,
} from "@/utils/mail-search/semantic-embedding";
import { createTextEmbedder } from "@/utils/mail-search/text-embedder";
import type {
  EmbeddingWorkerRequest,
  EmbeddingWorkerResponse,
} from "@/utils/mail-engine/embedding-worker-client";

// Runs the embedding model for the mail engine's worker, on a thread of its
// own so inference never holds up sync or commands. Only public model files
// come in from the network; the text it embeds stays on this device.
const MODEL_CACHE = `cue-semantic-model-${SEMANTIC_MODEL.id}`;
// The runtime's own build of the version installed, fetched only when the
// model first runs.
const ORT_WASM_URL = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ort.env.versions.web}/dist/ort-wasm-simd-threaded.wasm`;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = { wasm: ORT_WASM_URL };

let embedder: Promise<TextEmbedder> | null = null;

self.onmessage = async (event: MessageEvent<EmbeddingWorkerRequest>) => {
  const { id, texts } = event.data;
  try {
    embedder ??= createTextEmbedder({ ort, readFile: readModelFile });
    const vectors = await (await embedder).embed(texts);
    self.postMessage(
      { id, vectors } satisfies EmbeddingWorkerResponse,
      vectors.map((vector) => vector.buffer),
    );
  } catch (error) {
    // A failed load is retried on the next request.
    embedder = null;
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : "embedding_failed",
    } satisfies EmbeddingWorkerResponse);
  }
};

// Kept in Cache Storage so the model downloads once per device.
async function readModelFile(file: SemanticModelFile) {
  const url = semanticModelFileUrl(file);
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  const cached = await cache?.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model_download_${response.status}`);
  const bytes = new Uint8Array(await response.clone().arrayBuffer());
  await cache?.put(url, response).catch(() => undefined);
  return bytes;
}
