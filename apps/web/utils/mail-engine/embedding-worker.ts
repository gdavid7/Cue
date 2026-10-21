import * as ort from "onnxruntime-web/wasm";
import {
  isPinnedModelFile,
  SEMANTIC_MODEL,
  type SemanticModelFile,
  semanticModelFilePath,
  type TextEmbedder,
} from "@/utils/mail-search/semantic-embedding";
import { createTextEmbedder } from "@/utils/mail-search/text-embedder";
import {
  type EmbeddingWorkerRequest,
  type EmbeddingWorkerResponse,
  MODEL_INTEGRITY,
  MODEL_NOT_CACHED,
} from "@/utils/mail-engine/embedding-worker-protocol";

// Runs the embedding model for the mail engine's worker, on a thread of its
// own so inference never holds up sync or commands. The runtime's wasm and
// the model's files are this app's own assets, each model file checked
// against its pinned SHA-256. The text it embeds stays on this device.
const MODEL_CACHE = `cue-semantic-model-${SEMANTIC_MODEL.id}`;

ort.env.wasm.numThreads = 1;

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

// Kept in Cache Storage so the model downloads once per device. A device
// that can't keep it would download it again on every pass, so that fails
// instead.
async function readModelFile(file: SemanticModelFile) {
  const url = modelFileUrl(file);
  const cache = await caches.open(MODEL_CACHE).catch(() => null);
  if (!cache) throw new Error(MODEL_NOT_CACHED);
  await removeStaleModelFiles(cache);
  const cached = await cache.match(url);
  if (cached) {
    const bytes = new Uint8Array(await cached.arrayBuffer());
    if (await isPinnedModelFile(file, bytes)) return bytes;
    await cache.delete(url);
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model_download_${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!(await isPinnedModelFile(file, bytes))) throw new Error(MODEL_INTEGRITY);
  try {
    await cache.put(
      url,
      new Response(bytes, {
        headers: { "content-type": "application/octet-stream" },
      }),
    );
  } catch {
    throw new Error(MODEL_NOT_CACHED);
  }
  return bytes;
}

// Copies kept under an older address, such as the model repository's before
// Cue served the files itself, would otherwise hold their space for good.
async function removeStaleModelFiles(cache: Cache) {
  const current = new Set(
    (Object.keys(SEMANTIC_MODEL.files) as SemanticModelFile[]).map(
      modelFileUrl,
    ),
  );
  for (const request of await cache.keys())
    if (!current.has(request.url)) await cache.delete(request);
}

function modelFileUrl(file: SemanticModelFile) {
  return new URL(semanticModelFilePath(file), self.location.origin).href;
}
